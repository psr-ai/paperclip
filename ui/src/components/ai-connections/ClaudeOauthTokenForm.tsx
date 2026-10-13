import { SubscriptionCredentialForm, type SubscriptionCredentialFormProps } from "./SubscriptionCredentialForm";

/** Preserve Claude’s existing entry point while sharing private credential input. */
export function ClaudeOauthTokenForm(props: Omit<SubscriptionCredentialFormProps, "provider">) {
  return <SubscriptionCredentialForm {...props} provider="anthropic" />;
}
