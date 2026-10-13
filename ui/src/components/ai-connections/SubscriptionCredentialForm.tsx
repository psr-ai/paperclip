import { useEffect, useId, useRef, useState } from "react";
import type { AiConnectionLoginIntent } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SavedConnection = { connectionId: string; grantId: string };
export type SubscriptionImportProvider = "anthropic" | "openai" | "xai";
export type SubscriptionCredentialFormProps = {
  companyId: string; provider: SubscriptionImportProvider; intent: AiConnectionLoginIntent;
  disabled?: boolean; onSaved: (result: SavedConnection) => void | Promise<void>; onCancel: () => void;
};
const MAX_AUTH_BYTES = 131072;
const NAMES = { anthropic: "Claude", openai: "OpenAI", xai: "Grok" } as const;

/** Secret input belongs to this mounted attempt, never a draft or query cache. */
export function SubscriptionCredentialForm({ companyId, provider, intent, disabled = false, onSaved, onCancel }: SubscriptionCredentialFormProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [hasCredential, setHasCredential] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [fileLoaded, setFileLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef<SavedConnection | null>(null);
  const inFlight = useRef(false);
  const epoch = useRef(0);
  const fileEpoch = useRef(0);
  const claude = provider === "anthropic";
  const name = NAMES[provider];
  const clearInput = () => {
    if (input.current) input.current.value = "";
    if (fileInput.current) fileInput.current.value = "";
    setHasCredential(false); setFileLoaded(false);
  };
  useEffect(() => {
    const credentialElement = input.current;
    const fileElement = fileInput.current;
    epoch.current++; fileEpoch.current++;
    clearInput(); saved.current = null; inFlight.current = false;
    setBusy(false); setReadingFile(false); setError(null);
    return () => {
      epoch.current++; fileEpoch.current++;
      if (credentialElement) credentialElement.value = "";
      if (fileElement) fileElement.value = "";
      saved.current = null;
    };
  }, [companyId, provider, intent.connectionId]);
  const readFile = async (file: File | undefined) => {
    const attempt = ++fileEpoch.current;
    clearInput(); setError(null); setReadingFile(false);
    if (!file || disabled || inFlight.current) return;
    if (file.size > MAX_AUTH_BYTES) { setError("Choose an auth.json file smaller than 128 KiB."); return; }
    setReadingFile(true);
    let value = "";
    try {
      value = await file.text();
      if (attempt !== fileEpoch.current || !input.current) return;
      if (new TextEncoder().encode(value).length > MAX_AUTH_BYTES) {
        setError("Choose an auth.json file smaller than 128 KiB."); return;
      }
      input.current.value = value;
      setHasCredential(Boolean(value.trim())); setFileLoaded(true);
    } catch {
      if (attempt === fileEpoch.current) setError("Could not read auth.json. Choose the file again or paste its contents.");
    } finally {
      value = "";
      if (attempt === fileEpoch.current) setReadingFile(false);
    }
  };
  const submit = async () => {
    if (disabled || readingFile || inFlight.current || (!saved.current && !input.current?.value.trim())) return;
    const attempt = epoch.current;
    let submitted = input.current?.value.trim() ?? "";
    clearInput(); setError(null); setBusy(true); inFlight.current = true;
    try {
      if (!saved.current) {
        if (!claude) {
          if (new TextEncoder().encode(submitted).length > MAX_AUTH_BYTES) throw new Error("Invalid credential");
          const parsed: unknown = JSON.parse(submitted);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid credential");
        }
        const fields = { name: intent.name, ownership: intent.ownership, connectionId: intent.connectionId, agentIds: intent.agentIds, allAgents: intent.allAgents };
        const result = provider === "anthropic"
          ? await aiConnectionsApi.importClaudeOauthToken(companyId, { ...fields, token: submitted })
          : await aiConnectionsApi.importSubscriptionCredential(companyId, { ...fields, provider, credential: submitted });
        submitted = "";
        if (attempt !== epoch.current) return;
        saved.current = result;
      }
      await onSaved(saved.current);
    } catch {
      if (attempt !== epoch.current) return;
      // Never echo provider/transport errors, which may contain the input.
      setError(saved.current
        ? `${claude ? "Token" : "Sign-in"} saved, but connection setup did not finish. Retry to continue.`
        : claude ? "Could not save this Claude OAuth token. Check the token and your access, then try again."
          : `Could not save this ${name} sign-in. Check the complete auth.json file and your access, then try again.`);
    } finally {
      submitted = "";
      if (attempt === epoch.current) { inFlight.current = false; setBusy(false); }
    }
  };
  return <form className="space-y-4" aria-label={claude ? "Use existing Claude OAuth token" : `Import ${name} sign-in`}
    onSubmit={(event) => { event.preventDefault(); void submit(); }}
    onKeyDown={(event) => { if (event.key === "Enter") event.stopPropagation(); }}>
    <p className="text-sm text-muted-foreground">{claude
      ? "Save an existing Claude OAuth token as your subscription connection. Saving does not verify it. An agent test verifies access and may use your model quota."
      : `Import the complete ${provider === "openai" ? "Codex" : "Grok"} auth.json file, including its refresh token. Saving does not verify access. An agent test verifies the connection and may use your model quota.`}</p>
    {!claude && <p className="text-sm text-muted-foreground">{provider === "openai"
      ? "Use auth.json from your Codex login folder (usually ~/.codex). If your login is stored in a keychain, sign in separately with file credential storage for Paperclip. A separate sign-in avoids sharing a rotating login with your terminal."
      : "Use auth.json from your Grok login folder (usually ~/.grok). A separate Grok login for Paperclip avoids sharing a rotating login with your terminal."}</p>}
    {!claude && <p className="text-sm text-muted-foreground">Sign in with <code>{provider === "openai" ? "codex -c cli_auth_credentials_store=file login --device-auth" : "grok login --device-auth"}</code>. Use a separate {provider === "openai" ? "CODEX_HOME" : "GROK_HOME"} folder for Paperclip, then upload that folder’s auth.json.</p>}
    {intent.connectionId && <p className="text-sm text-muted-foreground">Saving replaces this connection’s existing {claude ? "token" : "sign-in"}. Runs using it stay blocked until an agent test verifies the replacement.</p>}
    {!saved.current && <>
      {!claude && <label htmlFor={`${id}-file`} className="block space-y-2 text-sm">
        <span>Upload auth.json</span>
        <Input ref={fileInput} id={`${id}-file`} type="file" accept=".json,application/json" disabled={busy || disabled}
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void readFile(file); }} />
      </label>}
      <label htmlFor={id} className="block space-y-2 text-sm">
        <span>{claude ? "Claude OAuth token" : "Or paste auth.json"}</span>
        <Input ref={input} id={id} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={claude ? 32768 : MAX_AUTH_BYTES}
          onChange={(event) => { fileEpoch.current++; setReadingFile(false); setFileLoaded(false); setHasCredential(Boolean(event.target.value.trim())); }} disabled={busy || disabled}
          placeholder={claude ? "Paste your Claude OAuth token" : "Paste the complete auth.json contents"} autoFocus />
      </label>
      {(readingFile || fileLoaded) && <p role="status" className="text-sm text-muted-foreground">{readingFile ? "Reading credential file…" : "Credential file loaded. Its contents stay hidden."}</p>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center justify-between gap-2">
      <Button type="button" variant="ghost" onClick={() => {
        epoch.current++; fileEpoch.current++; clearInput(); saved.current = null; setReadingFile(false); onCancel();
      }}>Cancel</Button>
      <Button type="submit" disabled={disabled || busy || readingFile || (!saved.current && !hasCredential)}>
        {busy ? "Saving…" : saved.current ? "Retry connection" : claude ? "Save OAuth token" : "Save sign-in"}
      </Button>
    </div>
  </form>;
}
