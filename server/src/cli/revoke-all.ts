import { revokeAll } from "#auth";

// Works with the server stopped. A running server rejects the old tokens on the next request or heartbeat.
const removed = await revokeAll();
console.log(`로그인 토큰 ${removed.length}개를 무효로 했습니다.`);
for (const s of removed) console.log(`  ${s.userAgent}  ${s.createdAt} 로그인`);
