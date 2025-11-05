/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { ToolErrorType } from './tool-error.js';
import { getErrorMessage } from '../utils/errors.js';
import { fetchWithTimeout } from '../utils/fetch.js';

interface GoogleRssNewsParams {
  op:
    | 'search_news'
    | 'search_by_domain'
    | 'search_multiple_domains';
  keywords?: string | string[];
  domain?: string;
  domains?: string[];
  period_hours?: number;
  language?: string;
  location?: string;
  ceid?: string;
  keywords_operator?: 'OR' | 'AND';
  max_results?: number;
}

interface NewsArticle {
  link: string;
  title: string;
  snippet: string;
  date: string;
  source: string;
}

interface GoogleRssNewsResult extends ToolResult {
  data?: {
    articles: NewsArticle[];
    total_count: number;
    query_url: string;
    summary: string;
  };
}

class GoogleRssNewsToolInvocation extends BaseToolInvocation<
  GoogleRssNewsParams,
  GoogleRssNewsResult
> {
  constructor(
    params: GoogleRssNewsParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const { op, keywords, domain, domains } = this.params;
    let desc = 'Search Google News RSS: ';

    if (op === 'search_news') {
      desc += `general search`;
    } else if (op === 'search_by_domain') {
      desc += `search in ${domain}`;
    } else if (op === 'search_multiple_domains') {
      desc += `search in ${domains?.length} domains`;
    }

    if (keywords) {
      const kwStr = Array.isArray(keywords) ? keywords.join(', ') : keywords;
      desc += ` for "${kwStr}"`;
    }

    return desc;
  }

  async execute(signal: AbortSignal): Promise<GoogleRssNewsResult> {
    try {
      const { op } = this.params;

      if (op === 'search_news' || op === 'search_by_domain') {
        return await this.searchSingleSource(signal);
      } else if (op === 'search_multiple_domains') {
        return await this.searchMultipleDomains(signal);
      }

      return {
        llmContent: `Unknown operation: ${op}`,
        returnDisplay: `Unknown operation: ${op}`,
        error: {
          message: `Unknown operation: ${op}`,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    } catch (error: unknown) {
      const errorMessage = `Error during Google RSS news search: ${getErrorMessage(error)}`;
      return {
        llmContent: `❌ **Search Error:** ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }

  private async searchSingleSource(
    signal: AbortSignal,
  ): Promise<GoogleRssNewsResult> {
    const {
      keywords,
      domain,
      period_hours,
      language,
      location,
      ceid,
      keywords_operator,
      max_results,
    } = this.params;

    const queryUrl = this.buildRssUrl(
      keywords,
      domain,
      period_hours,
      language,
      location,
      ceid,
      keywords_operator,
    );

    const articles = await this.fetchAndParseRss(queryUrl, max_results || 25, signal);

    const keywordsDesc = Array.isArray(keywords)
      ? keywords.join(', ')
      : keywords || '';
    const domainDesc = domain ? ` from ${domain}` : '';
    const timeDesc = period_hours ? ` (last ${period_hours}h)` : '';
    const summary = `Found ${articles.length} articles${keywordsDesc ? ` for '${keywordsDesc}'` : ''}${domainDesc}${timeDesc}`;

    return this.formatResult(articles, queryUrl, summary);
  }

  private async searchMultipleDomains(
    signal: AbortSignal,
  ): Promise<GoogleRssNewsResult> {
    const {
      domains,
      keywords,
      period_hours,
      language,
      location,
      ceid,
      keywords_operator,
      max_results,
    } = this.params;

    if (!domains || domains.length === 0) {
      return {
        llmContent: 'Error: domains parameter is required for search_multiple_domains operation',
        returnDisplay: 'Error: domains parameter required',
        error: {
          message: 'domains parameter is required',
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    const allArticles: NewsArticle[] = [];
    const queryUrls: string[] = [];

    for (const domain of domains) {
      const queryUrl = this.buildRssUrl(
        keywords,
        domain,
        period_hours,
        language,
        location,
        ceid,
        keywords_operator,
      );

      queryUrls.push(queryUrl);

      try {
        const articles = await this.fetchAndParseRss(
          queryUrl,
          max_results || 50,
          signal,
        );
        allArticles.push(...articles);
      } catch (error) {
        console.warn(`Failed to fetch from ${domain}:`, error);
      }
    }

    // Sort by date (newest first)
    allArticles.sort((a, b) => {
      const dateA = new Date(a.date || 0).getTime();
      const dateB = new Date(b.date || 0).getTime();
      return dateB - dateA;
    });

    // Limit total results
    const limitedArticles = allArticles.slice(0, max_results || 50);
    const summary = `Found ${limitedArticles.length} articles from ${domains.length} domains`;

    return this.formatResult(
      limitedArticles,
      queryUrls.join(' | '),
      summary,
    );
  }

  private buildRssUrl(
    keywords: string | string[] | undefined,
    domain: string | undefined,
    period_hours: number | undefined,
    language: string | undefined,
    location: string | undefined,
    ceid: string | undefined,
    keywords_operator: 'OR' | 'AND' | undefined,
  ): string {
    const queryParts: string[] = [];

    // Add time filter
    if (period_hours) {
      queryParts.push(`when:${period_hours}h`);
    }

    // Add domain filter
    if (domain) {
      queryParts.push(`site:${domain}`);
    }

    // Add keywords
    if (keywords) {
      if (Array.isArray(keywords)) {
        const encodedKeywords = keywords
          .filter((k) => k.trim())
          .map((k) => encodeURIComponent(k.trim()));

        if (encodedKeywords.length > 0) {
          const operator = keywords_operator?.toUpperCase() === 'AND' ? '+AND+' : '+OR+';
          if (encodedKeywords.length > 1) {
            queryParts.push(`(${encodedKeywords.join(operator)})`);
          } else {
            queryParts.push(encodedKeywords[0]);
          }
        }
      } else {
        queryParts.push(encodeURIComponent(keywords));
      }
    }

    const query = queryParts.join('+');
    let rssUrl = `https://news.google.com/rss/search?q=${query}`;

    if (language) {
      rssUrl += `&hl=${language}`;
    }
    if (location) {
      rssUrl += `&gl=${location}`;
    }
    if (ceid) {
      rssUrl += `&ceid=${ceid}`;
    }

    return rssUrl;
  }

  private async fetchAndParseRss(
    url: string,
    maxResults: number,
    signal: AbortSignal,
  ): Promise<NewsArticle[]> {
    const response = await fetchWithTimeout(url, 15000);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch RSS feed: ${response.status} ${response.statusText}`,
      );
    }

    const xmlText = await response.text();
    return this.parseRssXml(xmlText, maxResults);
  }

  private parseRssXml(xmlText: string, maxResults: number): NewsArticle[] {
    const articles: NewsArticle[] = [];

    // Simple XML parsing using regex (lightweight approach)
    // Extract all <item> elements
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    const items = xmlText.match(itemRegex) || [];

    for (let i = 0; i < Math.min(items.length, maxResults); i++) {
      const item = items[i];

      try {
        const title = this.extractXmlTag(item, 'title');
        const link = this.extractXmlTag(item, 'link');
        const description = this.extractXmlTag(item, 'description');
        const pubDate = this.extractXmlTag(item, 'pubDate');
        const source = this.extractXmlTag(item, 'source');

        articles.push({
          title: this.decodeHtmlEntities(title || 'No title'),
          link: link || '',
          snippet: this.decodeHtmlEntities(this.stripHtml(description || '')),
          date: this.formatDate(pubDate || ''),
          source: this.decodeHtmlEntities(source || 'Unknown source'),
        });
      } catch (error) {
        console.warn('Error parsing RSS item:', error);
      }
    }

    return articles;
  }

  private extractXmlTag(xml: string, tagName: string): string | null {
    const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 500);
  }

  private decodeHtmlEntities(text: string): string {
    const entities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&apos;': "'",
    };

    return text.replace(/&[#\w]+;/g, (entity) => entities[entity] || entity);
  }

  private formatDate(dateStr: string): string {
    if (!dateStr) return '';

    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return dateStr;

      return date.toISOString().replace('T', ' ').substring(0, 19);
    } catch {
      return dateStr;
    }
  }

  private formatResult(
    articles: NewsArticle[],
    queryUrl: string,
    summary: string,
  ): GoogleRssNewsResult {
    let content = `## ${summary}\n\n`;
    let display = `Google News: ${summary}\n\n`;

    if (queryUrl) {
      content += `**Query URL**: ${queryUrl}\n\n`;
    }

    if (articles.length > 0) {
      content += '### News Articles\n\n';

      for (const article of articles) {
        content += `#### ${article.title}\n`;
        content += `**Source**: ${article.source} | **Published**: ${article.date}\n`;
        content += `**Summary**: ${article.snippet}\n`;
        content += `**Link**: ${article.link}\n\n`;

        display += `${article.source}: ${article.title.substring(0, 60)}...\n`;
      }
    } else {
      content += 'No articles found.\n\n';
      display += 'No articles found.\n';
    }

    content += '*Data fetched from Google News RSS feed*\n';

    return {
      llmContent: content,
      returnDisplay: display,
      data: {
        articles,
        total_count: articles.length,
        query_url: queryUrl,
        summary,
      },
    };
  }
}

/**
 * Google RSS News Search Tool
 * Searches Google News RSS feed with flexible filtering options
 */
export class GoogleRssNewsTool extends BaseDeclarativeTool<
  GoogleRssNewsParams,
  GoogleRssNewsResult
> {
  static readonly Name: string = 'google_rss_news';

  constructor() {
    super(
      GoogleRssNewsTool.Name,
      'Google RSS News Search',
      `Search Google News RSS feed with flexible filtering options.

# When to use
- User asks for news from Google News
- Need to search news by keywords, domains, or specific sources
- Want to filter news by time period, language, or location

# When NOT to use
- User asks for economic/financial news specifically (use economic_news_tool instead)
- User needs very specific web content that requires full web scraping (use web_fetch instead)

# Features
- Search by single or multiple keywords (with OR/AND operators)
- Filter by specific domain(s) (e.g., bloomberg.com, reuters.com)
- Time-based filtering (e.g., last 24 hours)
- Language and geographic location filtering
- Supports Google News special query syntax (site:, when:, etc.)
`,
      Kind.Search,
      {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: [
              'search_news',
              'search_by_domain',
              'search_multiple_domains',
            ],
            description:
              'Operation to perform. MUST be one of: search_news (general keyword search), search_by_domain (search within specific domain), search_multiple_domains (search across multiple domains)',
          },
          keywords: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description:
              'Search keywords - can be a string or array of strings. If array, use keywords_operator to specify how to combine them (OR/AND)',
          },
          domain: {
            type: 'string',
            description:
              'Single domain to filter results (e.g., "bloomberg.com", "reuters.com"). Required for search_by_domain operation',
          },
          domains: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Multiple domains to search across (e.g., ["bloomberg.com", "reuters.com"]). Required for search_multiple_domains operation',
          },
          period_hours: {
            type: 'number',
            description:
              'Filter news from the last N hours (e.g., 24 for last day, 168 for last week)',
            minimum: 1,
            maximum: 720,
          },
          language: {
            type: 'string',
            description:
              'Language code for results (e.g., "en-US", "ja", "zh-CN")',
          },
          location: {
            type: 'string',
            description:
              'Geographic location code (e.g., "US", "JP", "CN")',
          },
          ceid: {
            type: 'string',
            description:
              'Combined region-language ID (e.g., "US:en", "JP:ja", "CN:zh")',
          },
          keywords_operator: {
            type: 'string',
            enum: ['OR', 'AND'],
            description:
              'How to combine multiple keywords: OR (any keyword matches) or AND (all keywords must match). Default: OR',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of articles to return (default: 25)',
            minimum: 1,
            maximum: 100,
          },
        },
        required: ['op'],
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected override validateToolParamValues(
    params: GoogleRssNewsParams,
  ): string | null {
    const { op, domain, domains, keywords } = params;

    if (op === 'search_by_domain' && !domain) {
      return 'domain parameter is required for search_by_domain operation';
    }

    if (op === 'search_multiple_domains' && (!domains || domains.length === 0)) {
      return 'domains parameter is required and must not be empty for search_multiple_domains operation';
    }

    if (!keywords && !domain && (!domains || domains.length === 0)) {
      return 'At least one of keywords, domain, or domains must be provided';
    }

    return null;
  }

  protected createInvocation(
    params: GoogleRssNewsParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<GoogleRssNewsParams, GoogleRssNewsResult> {
    return new GoogleRssNewsToolInvocation(
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
