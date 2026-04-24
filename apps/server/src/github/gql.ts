import type { DB } from "../db/client.js";
import { loadToken, saveToken } from "./tokens.js";
import { refreshToken } from "./device-flow.js";

export interface GqlClient {
  isConfigured: () => boolean;
  fetchPullRequest: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequestInfo | null>;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: "draft" | "open" | "closed" | "merged";
  headRefOid: string | null;
}

const QUERY = `
  query PR($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        url
        state
        isDraft
        merged
        headRefOid
      }
    }
  }
`;

interface RawPr {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  merged: boolean;
  headRefOid: string | null;
}

export function makeGqlClient(db: DB, key: Buffer, clientId: string): GqlClient {
  async function getAccessToken(): Promise<string | null> {
    const tok = loadToken(db, key);
    if (!tok) return null;
    if (tok.expires_at && tok.expires_at - Date.now() < 5 * 60 * 1000 && tok.refresh_token) {
      const refreshed = await refreshToken(clientId, tok.refresh_token);
      if (refreshed) {
        refreshed.login = tok.login;
        saveToken(db, key, refreshed);
        return refreshed.access_token;
      }
    }
    return tok.access_token;
  }

  return {
    isConfigured() {
      return !!loadToken(db, key);
    },
    async fetchPullRequest(owner, repo, number) {
      const token = await getAccessToken();
      if (!token) return null;
      const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
          "User-Agent": "kanco",
        },
        body: JSON.stringify({ query: QUERY, variables: { owner, repo, number } }),
      });
      if (!res.ok) {
        throw new Error(`gql ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        data?: { repository?: { pullRequest?: RawPr | null } | null };
        errors?: unknown;
      };
      const pr = body.data?.repository?.pullRequest;
      if (!pr) return null;
      const state: PullRequestInfo["state"] = pr.merged
        ? "merged"
        : pr.state === "CLOSED"
          ? "closed"
          : pr.isDraft
            ? "draft"
            : "open";
      return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state,
        headRefOid: pr.headRefOid,
      };
    },
  };
}
