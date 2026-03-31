import { readFile, stat } from "node:fs/promises";

export interface ReaderProfile {
  role: string;
  focusAreas: string[];
  coreInterests: string[];
  adjacentInterests: string[];
  lowValueTopics: string[];
  decisionContext: string;
  topicVocabulary: string[];
  raw: string;
}

export class ProfileLoader {
  private cachedProfile: ReaderProfile | null = null;
  private lastMtime: number = 0;

  constructor(private filePath: string) {}

  async load(): Promise<ReaderProfile> {
    const stats = await stat(this.filePath);
    const mtime = stats.mtimeMs;

    if (this.cachedProfile && mtime === this.lastMtime) {
      return this.cachedProfile;
    }

    const content = await readFile(this.filePath, "utf-8");
    const profile = this.parse(content);

    this.cachedProfile = profile;
    this.lastMtime = mtime;

    return profile;
  }

  private parse(content: string): ReaderProfile {
    const sections = new Map<string, string>();
    const lines = content.split("\n");

    let currentSection = "";
    let currentLines: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^##\s+(.+)/);
      if (headerMatch) {
        if (currentSection) {
          sections.set(currentSection.toLowerCase(), currentLines.join("\n"));
        }
        currentSection = headerMatch[1].trim();
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    if (currentSection) {
      sections.set(currentSection.toLowerCase(), currentLines.join("\n"));
    }

    const extractBullets = (sectionName: string): string[] => {
      const text = sections.get(sectionName.toLowerCase()) ?? "";
      return text
        .split("\n")
        .map((line) => line.match(/^[-*]\s+(.+)/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1].trim());
    };

    const extractText = (sectionName: string): string => {
      const bullets = extractBullets(sectionName);
      return bullets.join(" ");
    };

    const focusAreas = extractBullets("current focus areas");
    const coreInterests = extractBullets("core interests");
    const adjacentInterests = extractBullets("adjacent interests");
    const lowValueTopics = extractBullets("low-value topics");

    const topicVocabulary = [
      ...focusAreas,
      ...coreInterests,
      ...adjacentInterests,
    ];

    return {
      role: extractText("role & context"),
      focusAreas,
      coreInterests,
      adjacentInterests,
      lowValueTopics,
      decisionContext: extractText("decision-making context"),
      topicVocabulary,
      raw: content,
    };
  }
}
