import * as vscode from "vscode";

export interface CachedTicket {
  response: JiraIssueResponse;
  fetchedAt: number;
}

export class JiraTicketCache {
  private cache = new Map<string, CachedTicket>();
  private cleanupTimer: NodeJS.Timeout | undefined;
  private readonly CACHE_TTL = 10 * 60 * 1000; // 10 min
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 min
  private readonly NOT_FOUND_CACHE_TTL = 1 * 60 * 1000; // 1 min

  constructor(private context: vscode.ExtensionContext) {
    this.cleanupTimer = setInterval(() => this.clean(), this.CLEANUP_INTERVAL);
    context.subscriptions.push({
      dispose: () => clearInterval(this.cleanupTimer!),
    });
  }

  public async get(ticketId: string): Promise<JiraIssueResponse | undefined> {
    const cached = this.cache.get(ticketId);
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL) {
      if (cached.response.fields.summary !== "NOT FOUND") {
        return cached.response;
      }
      // Don't pull again if we're within the 404 cache.
      if (Date.now() - cached.fetchedAt < this.NOT_FOUND_CACHE_TTL) {
        return cached.response;
      }
      // Fallthrough, try again.
    }

    const url = this.getJiraUrlForTicket(ticketId);
    if (!url) {
      return;
    }

    const apiUrl = url.replace("/browse/", "/rest/api/2/issue/");
    const baseUrl = new URL(apiUrl).origin;
    const token = await this.context.secrets.get(`jiraToken:${baseUrl}`);
    if (!token) {
      return;
    }

    const username = await this.context.secrets.get(`jiraUsername:${baseUrl}`);
    if (!username) {
      return;
    }

    try {
      const res = await fetch(apiUrl, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString(
            "base64"
          )}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        if (res.status === 404) {
          this.cache.set(ticketId, {
            response: { fields: { summary: "NOT FOUND" } },
            fetchedAt: Date.now(),
          });
          return;
        }
        vscode.window.showErrorMessage(
          `Jira error ${res.status} for ${ticketId}`
        );
        return;
      }

      const jiraResp = (await res.json()) as JiraIssueResponse;

      this.cache.set(ticketId, {
        response: jiraResp,
        fetchedAt: Date.now(),
      });

      return jiraResp;
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to fetch ${ticketId}: ${err}`);
      return;
    }
  }

  private clean() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.fetchedAt > this.CACHE_TTL) {
        this.cache.delete(key);
      }
    }
  }

  private getJiraUrlForTicket(ticketId: string): string | undefined {
    const config = vscode.workspace.getConfiguration();
    const jiraConfigs =
      config.get<Record<string, { project_identifiers: string[] }>>(
        "jirax.jiraConfigs"
      ) || {};

    const prefix = ticketId.split("-")[0].toLowerCase();

    for (const [url, cfg] of Object.entries(jiraConfigs)) {
      if (
        (cfg.project_identifiers || [])
          .map((k) => k.toLowerCase())
          .includes(prefix)
      ) {
        return `${url}/browse/${ticketId}`;
      }
    }

    return undefined;
  }
}

export interface JiraIssueResponse {
  fields: {
    summary: string;
  };
}
