import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export { anthropic };

async function withRetry(fn, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isOverloaded = err?.status === 529 || err?.error?.type === 'overloaded_error';
      if (!isOverloaded || attempt === maxAttempts) throw err;
      const delay = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
      console.warn(`[retry] overloaded, attempt ${attempt}/${maxAttempts}, waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Tags to suppress from the live stream entirely.
// Inline signals (no closing tag) use '' as the end-marker so the scan loop
// drops only the token itself and immediately resumes — boundary-safe.
const SUPPRESS = {
  '[STATE]':               '[/STATE]',
  '[TOOL_CALL]':           '[/TOOL_CALL]',
  '[TRIP_UPDATE]':         '[/TRIP_UPDATE]',
  '[FETCH]':               '[/FETCH]',
  '[ADVANCE]':             '[/ADVANCE]',
  '[CONFIRM]':             '[/CONFIRM]',
  '[CHANGE]':              '[/CHANGE]',
  '[FLIGHT_CONFIRMED]':    '',
  '[HOTEL_CONFIRMED]':     '',
  '[MUST_SEES_CONFIRMED]': '',
  '[ITINERARY_CONFIRMED]': '',
  '[ACTIVITY_OK]':         '',
  '[ACTIVITY_MORE]':       '',
  '[ACTIVITY_SKIP]':       '',
};

// STRIP_INLINE is now only used in extractAndStripBlocks (non-streaming path)
const STRIP_INLINE = [
  '[FLIGHT_CONFIRMED]', '[HOTEL_CONFIRMED]', '[MUST_SEES_CONFIRMED]',
  '[ITINERARY_CONFIRMED]', '[ACTIVITY_OK]', '[ACTIVITY_MORE]', '[ACTIVITY_SKIP]',
];

const START_TAGS = Object.keys(SUPPRESS);
const MAX_TAG_LEN = Math.max(...START_TAGS.map(t => t.length));

export function extractAndStripBlocks(text) {
  const toolCallRegex = /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]|\[TOOL_CALL\][\s\S]*$/g;
  const stateRegex    = /\[STATE\][\s\S]*?\[\/STATE\]|\[STATE\][\s\S]*$/g;
  const newSignalRegex = /\[(TRIP_UPDATE|FETCH|ADVANCE|CONFIRM|CHANGE)\][\s\S]*?\[\/(?:TRIP_UPDATE|FETCH|ADVANCE|CONFIRM|CHANGE)\]|\[(TRIP_UPDATE|FETCH|ADVANCE|CONFIRM|CHANGE)\][\s\S]*$/g;

  let toolCall = null;
  for (const match of text.matchAll(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/g)) {
    try { toolCall = JSON.parse(match[1].trim()); } catch {}
  }

  const cleaned = text
    .replace(toolCallRegex, '')
    .replace(stateRegex, '')
    .replace(newSignalRegex, '')
    .replace(/\[SELECTED_FLIGHTS\][\s\S]*?\[\/SELECTED_FLIGHTS\]/g, '')
    .replace(/\[SELECTED_HOTELS\][\s\S]*?\[\/SELECTED_HOTELS\]/g, '')
    .replace(/\[SELECTED_ACTIVITIES\][\s\S]*?\[\/SELECTED_ACTIVITIES\]/g, '')
    .replace(/\[FLIGHT_CONFIRMED\]/g, '')
    .replace(/\[HOTEL_CONFIRMED\]/g, '')
    .replace(/\[MUST_SEES_CONFIRMED\]/g, '')
    .replace(/\[ITINERARY_CONFIRMED\]/g, '')
    .replace(/\[ACTIVITY_OK\]/g, '')
    .replace(/\[ACTIVITY_MORE\]/g, '')
    .replace(/\[ACTIVITY_SKIP\]/g, '')
    .replace(/\[ACTIVITY_CHANGE\][^\n]*/g, '')
    .replace(/\[FLIGHT_SELECTED\][^\n]*/g, '')
    .replace(/\[HOTEL_SELECTED\][^\n]*/g, '')
    .replace(/\[ACTIVITY_SELECTED\][^\n]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { cleaned, toolCall };
}

export async function streamClaude(systemPrompt, messages) {
  return withRetry(async () => {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    });

    let fullText = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        fullText += event.delta.text;
      }
    }
    return fullText;
  });
}

export async function streamClaudeSSE(systemPrompt, messages, sendFn) {
  const stream = await withRetry(() => {
    const s = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    return Promise.resolve(s);
  });

  let fullText = '';
  let buffer = '';
  let suppressing = null;

  for await (const event of stream) {
    if (event.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') continue;
    fullText += event.delta.text;
    buffer  += event.delta.text;

    let output = '';
    scan: while (buffer.length > 0) {
      if (suppressing !== null) {
        if (suppressing === '') {
          // Inline signal (no closing tag) — already consumed, just resume
          suppressing = null;
        } else {
          const endIdx = buffer.indexOf(suppressing);
          if (endIdx !== -1) {
            buffer = buffer.slice(endIdx + suppressing.length);
            suppressing = null;
          } else {
            buffer = buffer.slice(Math.max(0, buffer.length - (suppressing.length - 1)));
            break scan;
          }
        }
      } else {
        let earliestIdx = -1;
        let earliestTag = null;
        for (const tag of START_TAGS) {
          const idx = buffer.indexOf(tag);
          if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
            earliestIdx = idx;
            earliestTag = tag;
          }
        }
        if (earliestIdx !== -1) {
          output  += buffer.slice(0, earliestIdx);
          buffer   = buffer.slice(earliestIdx + earliestTag.length);
          suppressing = SUPPRESS[earliestTag];
        } else {
          const hold = MAX_TAG_LEN - 1;
          output += buffer.slice(0, buffer.length - hold);
          buffer  = buffer.slice(buffer.length - hold);
          break scan;
        }
      }
    }
    for (const tag of STRIP_INLINE) output = output.split(tag).join('');
    if (output) sendFn({ type: 'delta', text: output });
  }

  let remainder = !suppressing ? buffer : '';
  for (const tag of STRIP_INLINE) remainder = remainder.split(tag).join('');
  if (remainder) sendFn({ type: 'delta', text: remainder });

  return fullText;
}
