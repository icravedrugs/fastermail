import type { NewsletterItem } from "../db/index.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tierColor(tier: string): string {
  switch (tier) {
    case "must-read":
      return "#22c55e";
    case "nice-to-have":
      return "#3b82f6";
    case "skip":
      return "#9ca3af";
    default:
      return "#666";
  }
}

function tierLabel(tier: string): string {
  switch (tier) {
    case "must-read":
      return "Must-Read";
    case "nice-to-have":
      return "Nice-to-Have";
    case "skip":
      return "Skip";
    default:
      return tier;
  }
}

function renderTierButton(
  item: NewsletterItem,
  tier: string,
  token: string,
  baseUrl: string
): string {
  const isActive = item.tier === tier;
  const color = tierColor(tier);
  const bg = isActive ? color : "#fff";
  const fg = isActive ? "#fff" : color;
  const border = color;

  return `<button
    data-item="${item.id}" data-tier="${tier}"
    onclick="setTier(this, ${item.id}, '${tier}', '${escapeHtml(token)}', '${escapeHtml(baseUrl)}')"
    ${isActive ? 'disabled' : ''}
    style="
      padding: 4px 12px;
      margin: 0 4px;
      border: 2px solid ${border};
      border-radius: 4px;
      background: ${bg};
      color: ${fg};
      cursor: ${isActive ? "default" : "pointer"};
      font-size: 13px;
      font-weight: ${isActive ? "bold" : "normal"};
      opacity: ${isActive ? "1" : "0.85"};
      transition: opacity 0.15s;
    ">${tierLabel(tier)}</button>`;
}

function renderItem(item: NewsletterItem, token: string, baseUrl: string): string {
  const title = item.title || item.url;
  const titleHtml = item.url && !item.url.startsWith("forwarded:")
    ? `<a href="${escapeHtml(item.url)}" style="color: #2563eb; text-decoration: none;" target="_blank">${escapeHtml(title)}</a>`
    : escapeHtml(title);

  const descriptionHtml = item.description
    ? `<p style="margin: 4px 0 8px; color: #555; font-size: 14px;">${escapeHtml(item.description)}</p>`
    : "";

  const topicHtml = item.topicTag
    ? `<span style="display: inline-block; background: #f0f0f0; padding: 2px 8px; border-radius: 3px; font-size: 12px; color: #666; margin-right: 8px;">${escapeHtml(item.topicTag)}</span>`
    : "";

  const confidenceHtml = `<span style="font-size: 12px; color: #999;">${Math.round(item.confidence * 100)}%</span>`;

  return `
    <div id="item-${item.id}" style="padding: 12px 0; border-bottom: 1px solid #eee;">
      <div style="font-size: 15px; font-weight: 500;">${titleHtml}</div>
      ${descriptionHtml}
      <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 6px;">
        <div id="buttons-${item.id}">
          ${renderTierButton(item, "must-read", token, baseUrl)}
          ${renderTierButton(item, "nice-to-have", token, baseUrl)}
          ${renderTierButton(item, "skip", token, baseUrl)}
        </div>
        <div>${topicHtml}${confidenceHtml}</div>
        <span id="status-${item.id}" style="font-size: 12px; color: #999;"></span>
      </div>
    </div>`;
}

export function renderCorrectionsPage(
  items: NewsletterItem[],
  token: string,
  baseUrl: string
): string {
  // Group items by source email
  const grouped = new Map<string, NewsletterItem[]>();
  for (const item of items) {
    const group = grouped.get(item.emailId) || [];
    group.push(item);
    grouped.set(item.emailId, group);
  }

  let itemsHtml = "";
  for (const [emailId, groupItems] of grouped) {
    itemsHtml += `
      <div style="margin-bottom: 24px;">
        <div style="font-size: 12px; color: #999; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 2px solid #ddd;">
          Source: ${escapeHtml(emailId)}
        </div>
        ${groupItems.map((item) => renderItem(item, token, baseUrl)).join("")}
      </div>`;
  }

  if (items.length === 0) {
    itemsHtml = `<p style="color: #999; text-align: center; padding: 40px 0;">No newsletter items to review.</p>`;
  }

  const tierColors = JSON.stringify({
    "must-read": "#22c55e",
    "nice-to-have": "#3b82f6",
    "skip": "#9ca3af",
  });

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Newsletter Item Review</title>
</head>
<body style="font-family: sans-serif; max-width: 700px; margin: 30px auto; padding: 0 16px; color: #1a1a1a;">
  <h1 style="font-size: 22px; margin-bottom: 4px;">Newsletter Item Review</h1>
  <p style="color: #666; font-size: 14px; margin-top: 0;">Click a tier button to reclassify. Changes save instantly.</p>
  ${itemsHtml}
  <script>
    var TIER_COLORS = ${tierColors};

    function setTier(btn, itemId, tier, token, baseUrl) {
      var buttons = document.querySelectorAll('#buttons-' + itemId + ' button');
      var status = document.getElementById('status-' + itemId);

      // Disable all buttons, show saving
      buttons.forEach(function(b) { b.disabled = true; b.style.opacity = '0.5'; });
      status.textContent = 'saving...';
      status.style.color = '#999';

      var url = baseUrl + '/corrections/update?token=' + encodeURIComponent(token)
        + '&item=' + itemId + '&tier=' + tier + '&json=1';

      fetch(url)
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.ok) {
            // Update button styles to reflect new tier
            buttons.forEach(function(b) {
              var bTier = b.getAttribute('data-tier');
              var color = TIER_COLORS[bTier] || '#666';
              var isActive = bTier === tier;
              b.style.background = isActive ? color : '#fff';
              b.style.color = isActive ? '#fff' : color;
              b.style.borderColor = color;
              b.style.fontWeight = isActive ? 'bold' : 'normal';
              b.style.cursor = isActive ? 'default' : 'pointer';
              b.style.opacity = isActive ? '1' : '0.85';
              b.disabled = isActive;
            });
            status.textContent = 'saved';
            status.style.color = '#22c55e';
            setTimeout(function() { status.textContent = ''; }, 1500);
          } else {
            status.textContent = 'error';
            status.style.color = '#ef4444';
            buttons.forEach(function(b) { b.disabled = false; b.style.opacity = '1'; });
          }
        })
        .catch(function() {
          status.textContent = 'error';
          status.style.color = '#ef4444';
          buttons.forEach(function(b) { b.disabled = false; b.style.opacity = '1'; });
        });
    }
  </script>
</body>
</html>`;
}

export function renderCorrectionSuccess(
  item: NewsletterItem,
  newTier: string,
  token: string,
  baseUrl: string
): string {
  const title = item.title || item.url || `Item #${item.id}`;
  const backUrl = `${baseUrl}/corrections?token=${encodeURIComponent(token)}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="1;url=${escapeHtml(backUrl)}">
  <title>Updated</title>
</head>
<body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
  <h1 style="color: ${tierColor(newTier)};">Updated to ${tierLabel(newTier)}</h1>
  <p style="color: #666;">Updated <strong>${escapeHtml(title)}</strong> to <strong>${tierLabel(newTier)}</strong>.</p>
  <p><a href="${escapeHtml(backUrl)}" style="color: #3b82f6;">Back to review</a></p>
</body>
</html>`;
}

export function renderTokenError(expired: boolean): string {
  const title = expired ? "Link Expired" : "Invalid Link";
  const message = expired
    ? "This review link has expired. Check your latest digest email for a fresh link."
    : "Invalid review link.";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
  <h1>${title}</h1>
  <p style="color: #666;">${message}</p>
</body>
</html>`;
}
