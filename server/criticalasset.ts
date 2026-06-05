/**
 * CriticalAsset GraphQL client — SERVER SIDE ONLY.
 *
 * Credentials (CA_CLIENT_ID / CA_CLIENT_SECRET) never leave this process.
 * The browser only ever talks to our own /api/* routes.
 *
 * Schema notes (verified live against the staging API):
 *  - Auth is a GraphQL mutation `applicationClientCredentialsToken(input: {...})`,
 *    NOT a REST /oauth/token endpoint.
 *  - `workOrders` returns a `WorkOrderConnection { nodes, totalCount }`.
 *  - Dates come back as Unix-millisecond strings (e.g. "1780401131534").
 *  - `workOrderAssignments.users` currently 500s server-side, so we do not query it.
 */

const BASE_URL = (process.env.CA_BASE_URL ?? "https://40irving.stg.criticalasset.com").replace(/\/$/, "");
const ENDPOINT = `${BASE_URL}/api`;
const SCOPES = "assets.read locations.read workorders.read";

// ---------- Token cache ----------

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}
let tokenCache: TokenCache | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.CA_CLIENT_ID;
  const clientSecret = process.env.CA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing CA_CLIENT_ID / CA_CLIENT_SECRET. Copy .env.example to .env and fill them in.");
  }

  const mutation = `
    mutation AppToken($input: ApplicationClientCredentialsInput!) {
      applicationClientCredentialsToken(input: $input) {
        accessToken
        expiresIn
      }
    }`;

  const json = await rawPost(mutation, {
    input: { clientId, clientSecret, scope: SCOPES },
  });

  const tok = json.data?.applicationClientCredentialsToken;
  if (!tok?.accessToken) {
    throw new Error(`Auth failed: ${JSON.stringify(json.errors ?? json)}`);
  }

  tokenCache = {
    accessToken: tok.accessToken,
    expiresAt: now + (tok.expiresIn ?? 3600) * 1000,
  };
  return tok.accessToken;
}

// ---------- Low-level POST ----------

async function rawPost(query: string, variables: Record<string, unknown>, token?: string) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`CriticalAsset HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Authenticated GraphQL call with one automatic retry on auth failure. */
async function queryCA<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let token = await getAccessToken();
  let json = await rawPost(query, variables, token);

  // Token might have just expired -> force-refresh once.
  if (json.errors?.some((e: any) => /not authenticated|unauthor/i.test(e.message))) {
    tokenCache = null;
    token = await getAccessToken();
    json = await rawPost(query, variables, token);
  }

  if (json.errors?.length) {
    throw new Error(`CriticalAsset GraphQL error: ${json.errors.map((e: any) => e.message).join("; ")}`);
  }
  return json.data as T;
}

// ---------- Domain queries ----------

const WORK_ORDERS_QUERY = `
  query WorkOrders($limit: Int, $offset: Int) {
    workOrders(limit: $limit, offset: $offset) {
      totalCount
      nodes {
        id
        title
        description
        severity
        executionPriority
        workOrderType
        workOrderServiceCategory
        startDate
        endDate
        createdAt
        updatedAt
        locationAddress
        workOrderStage { id name color_code }
        location { id locationName address city state zipcode }
        workOrderAssets { id asset { id name status serialNumber lastServiceDate } }
        workOrderAssignments { id assignmentType }
      }
    }
  }`;

export interface RawWorkOrder {
  id: string;
  title: string | null;
  description: string | null;
  severity: string | null;
  executionPriority: string | null;
  workOrderType: string | null;
  workOrderServiceCategory: string | null;
  startDate: string | null;
  endDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  locationAddress: string | null;
  workOrderStage: { id: string; name: string; color_code: string | null } | null;
  location: {
    id: string;
    locationName: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zipcode: string | null;
  } | null;
  workOrderAssets: Array<{
    id: string;
    asset: { id: string; name: string | null; status: string | null; serialNumber: string | null; lastServiceDate: string | null } | null;
  }>;
  workOrderAssignments: Array<{ id: string; assignmentType: string | null }>;
}

export async function getWorkOrders(limit = 200, offset = 0) {
  const data = await queryCA<{ workOrders: { totalCount: number; nodes: RawWorkOrder[] } }>(
    WORK_ORDERS_QUERY,
    { limit, offset }
  );
  return data.workOrders;
}

const ASSETS_QUERY = `
  query Assets($limit: Int, $offset: Int) {
    assets(limit: $limit, offset: $offset) {
      total
      assets {
        id
        name
        description
        status
        serialNumber
        installationDate
        lastServiceDate
        lastInspectionDate
        locationAddress
      }
    }
  }`;

export async function getAssets(limit = 200, offset = 0) {
  const data = await queryCA<{ assets: { total: number; assets: any[] } }>(ASSETS_QUERY, {
    limit,
    offset,
  });
  return data.assets;
}

// Rich asset query for grounding: pulls SOP/troubleshooting (`information`) and
// regulatory `obligations`, which the enrichment & compliance agents stand on.
const ASSETS_RICH_QUERY = `
  query AssetsRich($limit: Int, $offset: Int) {
    assets(limit: $limit, offset: $offset) {
      total
      assets {
        id
        name
        description
        status
        locationAddress
        information
        obligations
        product { id name }
      }
    }
  }`;

export interface RichAsset {
  id: string;
  name: string | null;
  description: string | null;
  status: string | null;
  locationAddress: string | null;
  information: Array<{ question: string; answer: string; source: string }> | null;
  obligations: any[] | null;
  product: { id: string; name: string } | null;
}

export async function getAssetsRich(limit = 200, offset = 0) {
  const data = await queryCA<{ assets: { total: number; assets: RichAsset[] } }>(ASSETS_RICH_QUERY, {
    limit,
    offset,
  });
  return data.assets;
}

export { getAccessToken, queryCA };
