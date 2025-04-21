// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { exec } from "child_process";
import { JiraTicketCache } from "./jira";
import { config } from "process";
import { open } from "fs";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Launch Hover Provider
  const ticketCache = new JiraTicketCache(context);
  new JiraxHoverProvider(context, ticketCache);
  new JiraDocumentLinker(context);
  registerAddJiraUrlCommand(context);
  registerAddProjectKeyCommand(context);
  registerOpenTicketCommand(context);
  registerSetupTokenCommand(context);
}

// This method is called when your extension is deactivated
export function deactivate() {}

// =====================
//     Ticket Linker
// =====================

class JiraDocumentLinker implements vscode.DocumentLinkProvider {
  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.languages.registerDocumentLinkProvider("go", this)
    );
  }
  provideDocumentLinks(doc: vscode.TextDocument) {
    const links: vscode.DocumentLink[] = [];
    const regex = /\[\b([A-Z]+-\d+)\b\]/g;
    const projects = getJiraProjectPrefixes();

    for (let line = 0; line < doc.lineCount; line++) {
      const text = doc.lineAt(line).text;
      if (!text.trim().startsWith("//")) {
        continue;
      }

      let match: RegExpExecArray | null;
      while ((match = regex.exec(text))) {
        const projectKey = match[1].split("-")[0];
        if (!projects.has(projectKey)) {
          continue;
        }

        const start = new vscode.Position(line, match.index);
        const end = new vscode.Position(line, match.index + match[0].length);
        const range = new vscode.Range(start, end);
        const target = vscode.Uri.parse(
          `command:_jirax.openTicket?${encodeURIComponent(
            JSON.stringify([match[1]])
          )}`
        );
        const link = new vscode.DocumentLink(range, target);
        link.tooltip = formatJiraUrl(projects.get(projectKey)!, match[1]);
        links.push(link);
      }
    }

    return links;
  }
}

// ====================
//     Hover Helper
// ====================

class JiraxHoverProvider implements vscode.HoverProvider {
  private jiraCache: JiraTicketCache;

  constructor(context: vscode.ExtensionContext, jiraCache: JiraTicketCache) {
    this.jiraCache = jiraCache;
    context.subscriptions.push(
      vscode.languages.registerHoverProvider("go", this)
    );
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    if (!this.jiraCache) {
      return;
    }

    // Match ticket-like IDs: ABC-1234, XYZ-99, etc.
    const wordRange = document.getWordRangeAtPosition(
      position,
      /\b[A-Z]+-\d+\b/
    );
    if (!wordRange) {
      return;
    }

    // Only trigger if the line is a comment (starts with //)
    const lineText = document.lineAt(position.line).text.trim();
    if (!lineText.startsWith("//")) {
      return;
    }

    const ticketId = document.getText(wordRange);
    if (!getJiraProjectPrefixes().has(ticketId.split("-")[0])) {
      return;
    }

    const resp = await this.jiraCache.get(ticketId);
    if (!resp) {
      return;
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${resp.fields.summary}**\n\n`);
    markdown.isTrusted = true;

    return new vscode.Hover(markdown, wordRange);
  }
}

// ==============
//     Config
// ==============

interface JiraInstanceConfig {
  project_identifiers: string[];
}

type JiraConfigMap = Record<string, JiraInstanceConfig>;

export function getJiraProjectPrefixes(): Map<string, string> {
  const config = vscode.workspace.getConfiguration();
  const jiraConfigs = config.get<JiraConfigMap>("jirax.jiraConfigs") || {};

  const prefixes = new Map<string, string>();
  for (const [url, cfg] of Object.entries(jiraConfigs)) {
    for (const key of cfg.project_identifiers || []) {
      prefixes.set(key, url);
    }
  }

  return prefixes;
}

function formatJiraUrl(url: string, issue: string): string {
  return url + "/browse/" + issue;
}

// ================
//     Commands
// ================

function registerOpenTicketCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "_jirax.openTicket",
      async (ticketId: string) => {
        const projects = getJiraProjectPrefixes();
        var url = projects.get(ticketId.split("-")[0]);
        if (!url) {
          return;
        }
        if (url.endsWith("/")) {
          url = url.slice(0, -1);
        }

        const openWith = vscode.workspace
          .getConfiguration("jirax")
          .get("openWith") as string;

        switch (openWith) {
          case "browser":
            return vscode.env.openExternal(
              vscode.Uri.parse(url + "/browse/" + ticketId)
            );
          case "sys":
            // Allow "open" to be executed for apps handled to
            // open with the specified jira url.
            exec(`open ${url}/browse/${ticketId}`, (error, _, stderr) => {
              if (error) {
                vscode.window.showErrorMessage(
                  `Failed to open: ${error.message}`
                );
                return;
              }
              if (stderr) {
                console.warn(`stderr: ${stderr}`);
              }
            });
            break;
          default:
            vscode.window.showErrorMessage(
              `Unsupported jirax.openWith: ${openWith}`
            );
        }
      }
    )
  );
}

function registerAddJiraUrlCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("jirax.addURL", async () => {
      const config = vscode.workspace.getConfiguration();
      const jiraConfigs =
        config.get<Record<string, any>>("jirax.jiraConfigs") || {};

      var newUrl = await vscode.window.showInputBox({
        prompt: "Enter new Jira base URL (e.g. https://example.jira.com)",
        validateInput: (val) => (!val ? "URL required" : undefined),
      });

      if (!newUrl) {
        return;
      }

      if (newUrl.endsWith("/")) {
        newUrl = newUrl.slice(0, -1);
      }

      if (jiraConfigs[newUrl]) {
        vscode.window.showInformationMessage(`${newUrl} is already added.`);
        return;
      }

      jiraConfigs[newUrl] = { project_identifiers: [] };
      await config.update(
        "jirax.jiraConfigs",
        jiraConfigs,
        vscode.ConfigurationTarget.Global
      );
      vscode.window.showInformationMessage(`Jira config added for ${newUrl}`);
    })
  );
}

function registerAddProjectKeyCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("jirax.addProjectKey", async () => {
      const config = vscode.workspace.getConfiguration();
      const jiraConfigs =
        config.get<Record<string, any>>("jirax.jiraConfigs") || {};

      const urls = Object.keys(jiraConfigs);
      if (urls.length === 0) {
        vscode.window.showWarningMessage("No Jira URLs configured.");
        return;
      }

      const selectedUrl = await vscode.window.showQuickPick(urls, {
        placeHolder: "Select a Jira URL to add a project key to",
      });
      if (!selectedUrl) {
        return;
      }

      const newKey = await vscode.window.showInputBox({
        prompt: `Enter new project identifier (e.g. ABC) for ${selectedUrl}`,
        validateInput: (val) => {
          if (!/^[a-zA-Z0-9]+$/.test(val)) {
            return "Must be alphanumeric";
          }
          const valLower = val.toLowerCase();

          for (const [url, cfg] of Object.entries(jiraConfigs)) {
            const existing = (cfg.project_identifiers || []) as string[];
            if (existing.map((k) => k.toLowerCase()).includes(valLower)) {
              return `Project key "${val}" is already used for ${url}`;
            }
          }
          return undefined;
        },
      });

      if (!newKey) {
        return;
      }

      const normalizedKey = newKey.toUpperCase();
      const existingKeys: string[] =
        jiraConfigs[selectedUrl].project_identifiers || [];

      jiraConfigs[selectedUrl] = {
        project_identifiers: [...existingKeys, normalizedKey],
      };

      await config.update(
        "jirax.jiraConfigs",
        jiraConfigs,
        vscode.ConfigurationTarget.Global
      );
      vscode.window.showInformationMessage(
        `Added "${newKey}" to ${selectedUrl}`
      );
    })
  );
}

function registerSetupTokenCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("jirax.setToken", async () => {
      // Get the workspace configuration.
      const config = vscode.workspace.getConfiguration();
      const jiraConfigs =
        config.get<Record<string, any>>("jirax.jiraConfigs") || {};

      // Grab the URLS
      const urls = Object.keys(jiraConfigs);
      if (urls.length === 0) {
        // If there are no urls then we have a problem.
        vscode.window.showWarningMessage("No Jira URLs configured.");
        return;
      }

      // Give the user a URL they can select
      const url = await vscode.window.showQuickPick(urls, {
        placeHolder: "Select Jira URL",
      });
      if (!url) {
        return;
      }

      // Ask for email.
      const username = await vscode.window.showInputBox({
        prompt: "Enter Email",
      });

      // Ask for token.
      const token = await vscode.window.showInputBox({
        prompt: "Enter API Token",
        password: true,
      });

      if (token && username) {
        await context.secrets.store(`jiraToken:${url}`, token);
        await context.secrets.store(`jiraUsername:${url}`, username);
        vscode.window.showInformationMessage(`Token saved for ${url}`);
      }
    })
  );
}
