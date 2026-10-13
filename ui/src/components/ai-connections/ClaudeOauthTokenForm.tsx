import { useEffect, useId, useRef, useState } from "react";
import type { AiConnectionLoginIntent } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SavedConnection = { connectionId: string; grantId: string };

/** Private input belongs to this mounted attempt, never a draft or query cache. */
export function ClaudeOauthTokenForm({ companyId, intent, disabled = false, onSaved, onCancel }: {
  companyId: string;
  intent: AiConnectionLoginIntent;
  disabled?: boolean;
  onSaved: (result: SavedConnection) => void | Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef<SavedConnection | null>(null);
  const inFlight = useRef(false);
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; }, []);
  const submit = async () => {
    if (disabled || inFlight.current || (!saved.current && !token.trim())) return;
    const attempt = epoch.current;
    let submitted = token.trim();
    setToken("");
    setError(null);
    setBusy(true);
    inFlight.current = true;
    try {
      if (!saved.current) {
        const result = await aiConnectionsApi.importClaudeOauthToken(companyId, {
          token: submitted, name: intent.name, ownership: intent.ownership,
          connectionId: intent.connectionId, agentIds: intent.agentIds, allAgents: intent.allAgents,
        });
        submitted = "";
        if (attempt !== epoch.current) return;
        saved.current = result;
      }
      await onSaved(saved.current);
    } catch {
      if (attempt !== epoch.current) return;
      // Provider/transport errors must never echo submitted credentials.
      setError(saved.current
        ? "Token saved, but connection setup did not finish. Retry to continue."
        : "Could not save this Claude OAuth token. Check the token and your access, then try again.");
    } finally {
      submitted = "";
      if (attempt === epoch.current) { inFlight.current = false; setBusy(false); }
    }
  };
  return <form className="space-y-4" aria-label="Use existing Claude OAuth token"
    onSubmit={(event) => { event.preventDefault(); void submit(); }}
    onKeyDown={(event) => { if (event.key === "Enter") event.stopPropagation(); }}>
    <p className="text-sm text-muted-foreground">Save an existing Claude OAuth token as your subscription connection. Saving does not verify it. An agent test verifies access and may use your model quota.</p>
    {intent.connectionId && <p className="text-sm text-muted-foreground">Saving replaces this connection’s existing token. Runs using it stay blocked until an agent test verifies the replacement.</p>}
    {!saved.current && <label htmlFor={id} className="block space-y-2 text-sm">
      <span>Claude OAuth token</span>
      <Input id={id} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={32768}
        value={token} onChange={(event) => setToken(event.target.value)} disabled={busy || disabled}
        placeholder="Paste your Claude OAuth token" autoFocus />
    </label>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center justify-between gap-2">
      <Button type="button" variant="ghost" onClick={() => {
        epoch.current++; setToken(""); saved.current = null; onCancel();
      }}>Cancel</Button>
      <Button type="submit" disabled={disabled || busy || (!saved.current && !token.trim())}>
        {busy ? "Saving…" : saved.current ? "Retry connection" : "Save OAuth token"}
      </Button>
    </div>
  </form>;
}
