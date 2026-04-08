export interface SaveDocumentParams {
  url: string;
  html?: string;
  should_clean_html?: boolean;
  title?: string;
  author?: string;
  summary?: string;
  published_date?: string;
  tags?: string[];
  notes?: string;
  location?: "new" | "later" | "archive" | "feed";
  category?: "article" | "email" | "rss" | "video" | "tweet";
  saved_using?: string;
}

export interface SaveDocumentResponse {
  id: string;
  url: string;
}

export interface UpdateDocumentParams {
  tags?: string[];
  title?: string;
  author?: string;
  summary?: string;
  location?: "new" | "later" | "archive" | "feed";
  category?: "article" | "email" | "rss" | "video" | "tweet";
  notes?: string;
}
