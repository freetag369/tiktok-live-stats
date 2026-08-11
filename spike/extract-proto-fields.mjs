// Ground-truth extraction of the v3 protobuf field names the normalizer depends on.
// The library README is stale relative to the shipped schema; this reads the schema itself.
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../node_modules/tiktok-live-proto/dist/node/v3.d.ts', import.meta.url), 'utf8');
const lines = src.split(/\r?\n/);

/** Pull `interface Name {...}` bodies by brace counting (the file is generated, so this is safe). */
function extract(name) {
  const start = lines.findIndex((l) => new RegExp(`(interface|type)\\s+${name}\\b`).test(l));
  if (start < 0) return null;
  let depth = 0;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    out.push(l);
    depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
    if (i > start && depth <= 0) break;
    if (out.length > 400) break;
  }
  return out.join('\n');
}

/** Just the `name: type;` pairs, stripped of comments — easier to eyeball. */
function fields(name) {
  const body = extract(name);
  if (!body) return null;
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[a-zA-Z_$][\w$]*\??:\s/.test(l))
    .map((l) => l.replace(/;$/, ''));
}

const TARGETS = [
  'User',
  'CommonMessageData',
  'WebcastChatMessage',
  'WebcastLikeMessage',
  'WebcastGiftMessage',
  'WebcastMemberMessage',
  'WebcastSocialMessage',
  'WebcastRoomUserSeqMessage',
  'WebcastEmoteChatMessage',
  'WebcastEnvelopeMessage',
  'WebcastSubNotifyMessage',
  'WebcastQuestionNewMessage',
  'WebcastLiveIntroMessage',
  'WebcastControlMessage',
  'GiftStruct',
  'UserIdentity',
  'ImageModel',
  'BadgeStruct',
];

const report = {};
for (const t of TARGETS) {
  const f = fields(t);
  report[t] = f ?? '(NOT FOUND)';
}

// Answer the specific questions the normalizer hinges on.
const q = {
  'User has uniqueId?': /interface User\b[\s\S]{0,20000}?\buniqueId\??:/.test(src),
  'User.displayId exists': (fields('User') ?? []).some((l) => l.startsWith('displayId')),
  'User.idStr exists': (fields('User') ?? []).some((l) => l.startsWith('idStr')),
  'User.secUid exists': (fields('User') ?? []).some((l) => l.startsWith('secUid')),
  'Chat uses content': (fields('WebcastChatMessage') ?? []).some((l) => l.startsWith('content')),
  'Like uses count/total': (fields('WebcastLikeMessage') ?? []).some((l) => /^count:/.test(l)),
  'Gift repeatEnd type': (fields('WebcastGiftMessage') ?? []).find((l) => l.startsWith('repeatEnd')),
  'Gift gift field': (fields('WebcastGiftMessage') ?? []).find((l) => /^gift\??:/.test(l)),
  'RoomUserSeq fields': (fields('WebcastRoomUserSeqMessage') ?? []).filter((l) =>
    /^(total|totalUser|popularity|anonymous|ranks)/.test(l)
  ),
  'CommonMessageData createTime': (fields('CommonMessageData') ?? []).find((l) => l.startsWith('createTime')),
  'CommonMessageData msgId': (fields('CommonMessageData') ?? []).find((l) => l.startsWith('msgId')),
};

writeFileSync(
  new URL('./proto-fields.json', import.meta.url),
  JSON.stringify({ questions: q, interfaces: report }, null, 2),
  'utf8'
);
console.log(JSON.stringify(q, null, 2));
