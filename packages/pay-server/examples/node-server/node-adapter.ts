// node:http 요청 ↔ 표준 Request/Response (Node 20+ 의 fetch API 사용). 프레임워크 없이 @agent402-dev/pay-server 를 쓰는 최소 연결
import type { IncomingMessage, ServerResponse } from 'node:http';

export function nodeHandler(fetchHandler: (req: Request) => Promise<Response>, origin: string) {
  return async (inc: IncomingMessage, out: ServerResponse) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(inc.headers)) if (typeof v === 'string') headers.set(k, v); else if (Array.isArray(v)) headers.set(k, v.join(', '));
      const chunks: Buffer[] = [];
      for await (const c of inc) chunks.push(c as Buffer);
      const body = chunks.length && inc.method !== 'GET' && inc.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
      const res = await fetchHandler(new Request(new URL(inc.url ?? '/', origin), { method: inc.method, headers, body }));
      out.statusCode = res.status;
      res.headers.forEach((v, k) => out.setHeader(k, v));
      out.end(Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      out.statusCode = 500;
      out.setHeader('content-type', 'application/json');
      out.end(JSON.stringify({ error: 'internal_error' }));
      console.error(e);
    }
  };
}
