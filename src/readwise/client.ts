import {
  SaveDocumentParams,
  SaveDocumentResponse,
  UpdateDocumentParams,
} from "./types.js";

const BASE_URL = "https://readwise.io/api/v3";

export class ReadwiseClient {
  constructor(private readonly token: string) {}

  private async fetch<T>(
    url: string,
    options: RequestInit = {},
    retry = true
  ): Promise<Response> {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Token ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (response.status === 429 && retry) {
      const retryAfter = response.headers.get("Retry-After");
      const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.fetch<T>(url, options, false);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Readwise authentication failed (${response.status}): check that your API token is valid`
      );
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Readwise API request failed: ${response.status} ${text}`
      );
    }

    return response;
  }

  async save(params: SaveDocumentParams): Promise<SaveDocumentResponse> {
    const response = await this.fetch<SaveDocumentResponse>(
      `${BASE_URL}/save/`,
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    );

    return response.json() as Promise<SaveDocumentResponse>;
  }

  async update(
    documentId: string,
    params: UpdateDocumentParams
  ): Promise<void> {
    await this.fetch<void>(`${BASE_URL}/update/${documentId}/`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
  }

  async delete(documentId: string): Promise<void> {
    await this.fetch<void>(`${BASE_URL}/delete/${documentId}/`, {
      method: "DELETE",
    });
  }
}
