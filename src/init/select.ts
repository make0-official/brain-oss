/** Turn a prompt answer into a subset of `clients`. Empty and "all" select every client. "none" selects none. */
export function parseClientSelection<T extends { id: string }>(answer: string, clients: readonly T[]): T[] | null {
  const text = answer.trim().toLowerCase();
  if (text === "" || text === "all") return [...clients];
  if (text === "none") return [];

  const byId = new Map(clients.map((client) => [client.id, client]));
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const chosen = clientsForToken(token, clients, byId);
    if (!chosen) return null;
    for (const client of chosen) {
      if (seen.has(client.id)) continue;
      seen.add(client.id);
      picked.push(client);
    }
  }
  return picked;
}

function clientsForToken<T extends { id: string }>(
  token: string,
  clients: readonly T[],
  byId: Map<string, T>,
): T[] | null {
  const range = /^(\d+)-(\d+)$/.exec(token);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start < 1 || end > clients.length || start > end) return null;
    return clients.slice(start - 1, end);
  }
  if (/^\d+$/.test(token)) {
    const index = Number(token);
    if (index < 1 || index > clients.length) return null;
    return [clients[index - 1]];
  }
  const match = byId.get(token);
  return match ? [match] : null;
}

/** Ask which of the detected agents to configure. An empty list means the user chose none. */
export async function promptForClients<T extends { id: string; name: string }>(
  clients: readonly T[],
  ask: (question: string) => Promise<string>,
  log: (line: string) => void,
): Promise<T[]> {
  log("\nFound these agents:");
  clients.forEach((client, index) => {
    log(`  ${index + 1}. ${client.name}`);
  });
  const ids = clients.map((client) => client.id).join(", ");
  for (;;) {
    const answer = await ask("\nConfigure which? Numbers (1,3 or 1-3) or ids. Enter for all [all]: ");
    const picked = parseClientSelection(answer, clients);
    if (picked) return picked;
    log(`  Use 1-${clients.length}, ${ids}, all, or none.`);
  }
}
