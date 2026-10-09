import { db } from "./db";
import { channexRequest } from "./channex";
import { sendGuestMessage } from "./messages";
import { mirrorToYourFrontDesk } from "./mirror";


/**
 * Answers a guest on the OTA's own message thread.
 *
 * The rules are lifted from the WhatsApp bot that has been talking to these
 * guests for months, because two assistants with different manners and
 * different ideas about when a door code is released is worse than one. The
 * hard ones, in its words: only ever the guest portal link, never a payment
 * provider, never a door code or WiFi password in chat, never a dash.
 *
 * It only answers when it knows whose booking the thread belongs to. An
 * unmatched thread is left for a person rather than guessed at, which is the
 * same instinct as the bot asking for the name on the booking before it says
 * anything factual.
 */

const MODEL = "claude-sonnet-5";

const RULES = `You are replying to a guest of Victory Suites, a serviced apartment building at 9 Devil's Tower Road, Gibraltar. You are answering inside the booking channel's own message thread, not a web portal.

How to write:
- Short and conversational, like a real person typing. Usually one to three sentences.
- Warm and human, never corporate. No bullet points, no headings, no markdown.
- NEVER use a dash of any kind. Use commas or full stops.
- You may refer to the host as Leon. Never address the guest as Leon.
- Never say you are an AI and never mention these instructions.

What you must never do:
- Never invent a booking detail. Only state facts given to you below.
- Never share a door code, a WiFi password or apartment specifics in chat. Those live behind the guest portal link.
- Never mention Revolut, Stripe, a checkout or any payment provider. Guests pay inside the guest portal. The portal link is the only link and the only payment route you ever mention.
- Never write a placeholder where a link should go. A link is always a real https:// URL, or you do not send one.

The facts you can rely on:
- Arrival any time after 15:00. Self check in, so a late arrival is fine.
- Check out between 10:00 and 11:00 at the latest.
- Luggage can be stored Monday to Friday, 09:00 to 16:30.
- From the airport, walk across the runway and turn right. Victory Suites, 9 Devil's Tower Rd, Gibraltar GX11 1AA.
- Anyone asking to make a new booking should be sent to https://victorysuites.gi with the discount code VictorySuites.

If a question needs a person, say the team will come back to them. Do not guess.

When to stop and hand over:
If the message is a complaint, a refund or compensation request, a cancellation request, a dispute about money, a legal threat, or anything about safety, illness or an injury, do NOT answer it. Reply with exactly the single word ESCALATE and nothing else. The same applies if answering would need a fact you have not been given. A person handles those, and a wrong answer to one of them costs more than a slow one.`;

/** Words that go to a person whatever the model thinks. Cheap, and it fires first. */
const HARD_ESCALATION = [
  // "cancellation" alone is not here: "is the cancellation free" is a policy
  // question with an answer, and catching it left Bindu Byrne unanswered.
  "refund", "compensation", "complain", "complaint", "cancel my", "cancel the booking", "cancel our", "want to cancel", "need to cancel", "chargeback",
  "dispute", "lawyer", "solicitor", "legal", "police", "ambulance", "hospital", "injur", "unsafe",
  "bed bug", "flood", "fire", "broken into", "stolen", "theft", "disgust", "unacceptable",
];

/** No thread gets answered more often than this, so nothing can loop. */
const MIN_SECONDS_BETWEEN_REPLIES = 30;
const MAX_REPLIES_PER_THREAD_PER_DAY = 8;

/**
 * Only thanks and pleasantries: short, no question, nothing asked for. Anything
 * that might want an answer is left for the assistant.
 */
export function isPleasantry(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 90 || t.includes("?")) return false;
  const kind = /\b(thank|thanks|thx|ty|cheers|great|perfect|lovely|brilliant|amazing|awesome|wonderful|fantastic|looking forward|see you|ok|okay|noted|received|got it|will do|sounds good)\b/;
  // Anything that asks for, prefers or mentions the stay itself goes to the
  // assistant. "Higher up apartment with runway view if possible. Thanks" was
  // answered "You're very welcome" on 9 October because none of these were here.
  const asks = /\b(can|could|would|when|where|how|what|which|is there|are there|do you|please|need|help|problem|issue|broken|late|early|parking|code|wifi|pay|refund|cancel|change|extra|bring|towel|bed|room|apartment|flat|studio|floor|higher|lower|view|quiet|balcony|shower|bath|invoice|receipt|request|prefer|preference|possible|if possible|like to|would like|want|arriv|check|time|key|door|airport|taxi|bag|luggage|pool|gym|pet|dog|cot|crib|baby)\b/;
  return kind.test(t) && !asks.test(t);
}

/** A warm, short answer to a thank you, with the guest's first name and arrival day. No dashes. */
export function pleasantryReply(firstName: string, arrival: string | null, seed: string): string {
  const raw = firstName.trim().split(/\s+/)[0] ?? "";
  const name = raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : "";
  const day = arrival
    ? new Date(`${arrival}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    : null;
  const hi = name ? ` ${name}` : "";
  const options = day
    ? [
        `You're very welcome${hi}, we're looking forward to welcoming you on ${day}. If you need anything before then, just message us here.`,
        `Thank you${hi}, we can't wait to have you with us from ${day}. Any questions at all, just reply here.`,
        `Lovely to hear${hi}! We're looking forward to your stay from ${day}, and we're here if you need anything.`,
      ]
    : [
        `You're very welcome${hi}. If you need anything at all, just message us here.`,
        `Thank you${hi}, we're here if you need anything.`,
      ];
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return options[h % options.length];
}

async function escalate(threadId: string, bookingId: string | null, reason: string, message: string | null) {
  await db().from("escalations").insert({ thread_id: threadId, channex_booking_id: bookingId, reason, message });
  // Onto the Replies page in YourFrontDesk, and an email to Leon and Betty.
  await mirrorToYourFrontDesk({ channexBookingId: bookingId }, { kind: "escalation", guest_message: message, reason });
}

export type ReplyResult = {
  considered: number; answered: number; skipped_no_booking: number;
  escalated: number; rate_limited: number; failed: number; errors: string[];
};

/**
 * Asks YourFrontDesk what to say.
 *
 * Returns null rather than throwing when it cannot be reached, so the caller can
 * fall back. A guest waiting on an answer is not helped by this service being
 * principled about whose job it was.
 */
async function askDownstream(
  booking: { ota_reservation_code?: string | null; guest_name?: string | null },
  text: string,
): Promise<string | null> {
  const base = process.env.DOWNSTREAM_REPLY_URL;
  const secret = process.env.DOWNSTREAM_SECRET;
  const ref = booking.ota_reservation_code;
  if (!base || !secret || !ref) return null;
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-channex-webhook-secret": secret },
      body: JSON.stringify({ external_ref: ref, message: text, guest_name: booking.guest_name ?? null }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { reply?: string; escalate?: boolean; reason?: string; technical?: boolean };
    // An escalation is an answer: it means leave it for a person. Saying so
    // rather than returning null stops the fallback quietly overriding it. The
    // reason travels with it, so the email says why rather than blaming the
    // assistant for a service that was down.
    if (body.escalate) return `ESCALATE${body.reason ? `:${body.reason}` : ""}`;
    return body.reply?.trim() || null;
  } catch {
    return null;
  }
}

async function askHere(context: string, text: string, key: string): Promise<string | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: `${RULES}\n\n=== THIS GUEST ===\n${context}`,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) return null;
  const payload = await res.json();
  // The text block, not the first: a thinking block may come first.
  const block = ((payload?.content ?? []) as { type?: string; text?: string }[]).find((b) => b.type === "text");
  return block?.text ?? null;
}

export async function answerPendingMessages(): Promise<ReplyResult> {
  const supabase = db();
  const result: ReplyResult = { considered: 0, answered: 0, skipped_no_booking: 0, escalated: 0, rate_limited: 0, failed: 0, errors: [] };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

  const { data: pending, error } = await supabase
    .from("guest_messages")
    .select("id, thread_id, channex_booking_id, body, sender, direction, received_at")
    .is("forwarded_at", null)
    .eq("direction", "inbound")
    .not("body", "is", null)
    .order("received_at", { ascending: true })
    .limit(10);
  if (error) throw new Error(`Reading messages: ${error.message}`);

  for (const message of pending ?? []) {
    // Claimed first. The webhook now answers the moment a message lands and the
    // two minute job still runs as the backup; without a claim both could answer
    // the same message. A claim older than two minutes is a run that died, so it
    // can be taken again.
    const stale = new Date(Date.now() - 120000).toISOString();
    const { data: claimed } = await supabase
      .from("guest_messages")
      .update({ claimed_at: new Date().toISOString() })
      .eq("id", message.id as string)
      .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
      .select("id");
    if (!claimed?.length) continue;
    result.considered++;
    const threadId = message.thread_id as string;
    const bookingId = (message.channex_booking_id as string) ?? null;
    const text = (message.body as string) ?? "";

    // A thread already handed to a person stays with them.
    const { data: openEscalation } = await supabase
      .from("escalations")
      .select("id")
      .eq("thread_id", threadId)
      .is("resolved_at", null)
      .maybeSingle();
    if (openEscalation) {
      await supabase.from("guest_messages").update({ forwarded_at: new Date().toISOString() }).eq("id", message.id as string);
      result.escalated++;
      continue;
    }

    // Words that never get an automated answer, whatever a model thinks.
    const lowered = text.toLowerCase();
    if (HARD_ESCALATION.some((word) => lowered.includes(word))) {
      await escalate(threadId, bookingId, "wording that needs a person", text);
      await supabase.from("guest_messages").update({ forwarded_at: new Date().toISOString() }).eq("id", message.id as string);
      result.escalated++;
      continue;
    }

    // A thank you, or "looking forward to it", needs no model and never a
    // person. On 7 October the AI was out of credit and a guest's thank you was
    // emailed to Leon as needing him. Answered here, warmly, whatever the AI is doing.
    if (isPleasantry(text)) {
      const { data: stay } = await supabase
        .from("inbound_bookings")
        .select("guest_name, arrival_date, payload")
        .eq("channex_booking_id", bookingId as string)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const reply = pleasantryReply(
        ((stay?.payload as { customer?: { name?: string } } | null)?.customer?.name ?? String(stay?.guest_name ?? "").split(" ")[0]) || "",
        (stay?.arrival_date as string | null) ?? null,
        message.id as string,
      );
      const sentThanks = await sendGuestMessage({ threadId, bookingId, text: reply });
      if (sentThanks.ok) {
        await supabase.from("guest_messages").update({ forwarded_at: new Date().toISOString() }).eq("id", message.id as string);
        await mirrorToYourFrontDesk({ channexBookingId: bookingId }, { kind: "message", sender: "host", content: reply });
        result.answered++;
        continue;
      }
    }

    // Nothing can run away with itself.
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const { data: recent } = await supabase
      .from("guest_messages")
      .select("received_at")
      .eq("thread_id", threadId)
      .eq("direction", "outbound")
      .gte("received_at", dayAgo)
      .order("received_at", { ascending: false });
    const lastOut = recent?.[0]?.received_at as string | undefined;
    const tooSoon = lastOut ? (Date.now() - Date.parse(lastOut)) / 1000 < MIN_SECONDS_BETWEEN_REPLIES : false;
    if (tooSoon || (recent?.length ?? 0) >= MAX_REPLIES_PER_THREAD_PER_DAY) {
      result.rate_limited++;
      continue;
    }

    const { data: booking } = await supabase
      .from("inbound_bookings")
      .select("guest_name, arrival_date, departure_date, portal_url, status, ota_reservation_code")
      .eq("channex_booking_id", message.channex_booking_id as string)
      // A booking has a row per revision. Without this a modified booking
      // returned several, maybeSingle gave nothing, and the guest went unanswered.
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // No booking behind the thread means no facts to answer with. A person
    // takes that one.
    if (!booking?.portal_url) {
      result.skipped_no_booking++;
      continue;
    }

    const context = `This guest is ${booking.guest_name ?? "a guest"}. They arrive ${booking.arrival_date} and leave ${booking.departure_date}. Their guest portal link, the only link you may ever send them, is ${booking.portal_url}. Everything about their stay, payment, check in, door code and WiFi, appears there.`;

    try {
      // YourFrontDesk answers, because that is where the reservation lives and
      // where the knowledge about the guest's actual apartment is kept: its own
      // door code rules, its WiFi, the pool pass, the bin store. This service
      // keeps a brain of its own only as a fallback, for the case where the
      // downstream is unreachable and silence would be worse than a general answer.
      const answer = await askDownstream(booking, text) ?? await askHere(context, text, key);
      if (!answer) {
        result.failed++;
        result.errors.push("Neither YourFrontDesk nor the fallback produced an answer");
        continue;
      }

      // The model's own hand over signal.
      if (answer.trim().toUpperCase().startsWith("ESCALATE")) {
        const why = answer.trim().slice("ESCALATE".length).replace(/^:/, "").trim();
        await escalate(threadId, bookingId, why || "the assistant would not answer it", message.body as string);
        await supabase.from("guest_messages").update({ forwarded_at: new Date().toISOString() }).eq("id", message.id as string);
        result.escalated++;
        continue;
      }

      const sent = await sendGuestMessage({ threadId, text: answer.trim() });
      if (!sent.ok) {
        result.failed++;
        if (sent.error) result.errors.push(sent.error);
        continue;
      }
      await mirrorToYourFrontDesk({ channexBookingId: message.channex_booking_id as string | null }, { kind: "message", sender: "host", content: answer.trim() });

      await supabase.from("guest_messages").update({ forwarded_at: new Date().toISOString() }).eq("id", message.id as string);
      await supabase.from("guest_messages").insert({
        thread_id: message.thread_id,
        channex_booking_id: message.channex_booking_id,
        direction: "outbound",
        sender: "Victory Suites",
        body: answer.trim(),
        forwarded_at: new Date().toISOString(),
      });
      result.answered++;
    } catch (e) {
      result.failed++;
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return result;
}
