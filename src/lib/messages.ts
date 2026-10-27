import { channexRequest } from "./channex";

/**
 * Sends a message to a guest through Channex, the one way the Booking.com
 * conversation can be reached.
 *
 * Two faults lived here until 6 October 2026, found when the first five real
 * bookings on the no balcony listing all came back "no_thread" and no guest got
 * their portal link:
 *  - a booking the guest has never written about has no thread, and the code
 *    only knew how to post into a thread. Channex messages a booking directly
 *    with POST /bookings/{id}/messages, which opens the conversation.
 *  - the body was { message: text }. Channex documents { message: { message:
 *    text } } for both endpoints, so a reply into an existing thread was being
 *    sent in a shape Channex does not take.
 *
 * Prefers the thread when there is one, otherwise the booking.
 */
export async function sendGuestMessage(opts: {
  threadId?: string | null;
  bookingId?: string | null;
  text: string;
  propertyId?: string | null;
}): Promise<{ ok: boolean; threadId: string | null; error: string | null }> {
  const body = { message: { message: opts.text } };
  const path = opts.threadId
    ? `/message_threads/${opts.threadId}/messages`
    : opts.bookingId
      ? `/bookings/${opts.bookingId}/messages`
      : null;
  if (!path) return { ok: false, threadId: null, error: "Neither a thread nor a booking to send to" };

  const res = await channexRequest<{ data?: { relationships?: { message_thread?: { data?: { id?: string } } } } }>(
    "POST",
    path,
    body,
    { propertyId: opts.propertyId ?? null, retries: 1 },
  );
  if (!res.ok) {
    const reason =
      res.status === 403
        ? "Channex refused: the Messages app is not installed on this property"
        : res.status === 422
          ? "Channex refused: this booking's channel does not take messages"
          : res.error ?? `Channex returned ${res.status}`;
    return { ok: false, threadId: opts.threadId ?? null, error: reason };
  }
  return { ok: true, threadId: res.body?.data?.relationships?.message_thread?.data?.id ?? opts.threadId ?? null, error: null };
}
