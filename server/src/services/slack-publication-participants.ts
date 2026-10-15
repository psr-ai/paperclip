import { and, eq } from "drizzle-orm";
import { chatDeliveries, chatEndpoints, chatExternalPrincipals, chatMessageLinks, type Db } from "@paperclipai/db";

/** Names are eligible only after authenticated inbound processing in this exact
 * conversation. This lookup grants no additional messaging or task authority. */
export function loadSlackPublicationParticipants(
  db: Pick<Db, "selectDistinct">,
  scope: { companyId: string; endpointId: string; conversationId: string },
) {
  return db.selectDistinct({
    externalId: chatExternalPrincipals.externalId,
    handle: chatExternalPrincipals.handle,
    displayName: chatExternalPrincipals.displayName,
  }).from(chatMessageLinks)
    .innerJoin(chatEndpoints, and(
      eq(chatEndpoints.id, scope.endpointId),
      eq(chatEndpoints.companyId, scope.companyId),
      eq(chatEndpoints.provider, "slack"),
    ))
    .innerJoin(chatDeliveries, and(
      eq(chatDeliveries.id, chatMessageLinks.deliveryId),
      eq(chatDeliveries.companyId, scope.companyId),
      eq(chatDeliveries.endpointId, scope.endpointId),
      eq(chatDeliveries.conversationId, scope.conversationId),
      eq(chatDeliveries.state, "processed"),
    ))
    .innerJoin(chatExternalPrincipals, and(
      eq(chatExternalPrincipals.id, chatDeliveries.principalId),
      eq(chatExternalPrincipals.companyId, scope.companyId),
      eq(chatExternalPrincipals.provider, "slack"),
      eq(chatExternalPrincipals.providerAccountId, chatEndpoints.providerAccountId),
    ))
    .where(and(
      eq(chatMessageLinks.companyId, scope.companyId),
      eq(chatMessageLinks.endpointId, scope.endpointId),
      eq(chatMessageLinks.conversationId, scope.conversationId),
      eq(chatMessageLinks.direction, "inbound"),
    ));
}
