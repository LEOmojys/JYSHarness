/**
 * 出站请求的地址校验（防 SSRF）。
 *
 * 两道闸：
 *   1. 字面 host 黑名单（localhost / 私有段 / .local / .internal）；
 *   2. DNS 解析后再查一次 IP —— 挡住 nip.io 这类"域名指向 127.0.0.1"的写法。
 * 再加一条：**重定向逐跳校验**。只查初始 URL 是假的，一个 302 就能把请求
 * 引到内网。抓取逻辑用 redirect: "manual" 自己跟，每跳都过同一套校验。
 *
 * 明确挡不住的：TOCTOU（校验和连接之间 DNS 被换）与同一子网内的合法服务。
 * 完整防护需要连接级 IP 固定，超出这一层的职责。
 */
import { lookup } from "node:dns/promises";

const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /\.local$/i,
  /\.internal$/i,
];

export function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOSTS.some((re) => re.test(hostname));
}

export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = v4.exec(ip);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 校验一个 URL 是否可以出去：协议、字面 host、解析后的 IP。
 * edges: 允许测试注入解析函数（避免测试依赖真实 DNS）。
 */
export async function checkUrl(url: URL, resolve: (host: string) => Promise<string[]> = async (host) => {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}): Promise<UrlCheck> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "only http(s) URLs are allowed" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHost(url.hostname) || isBlockedHost(host)) {
    return { ok: false, reason: "refusing to fetch a private/loopback host: " + url.hostname };
  }
  if (isPrivateAddress(host)) {
    return { ok: false, reason: "refusing to fetch a private address: " + host };
  }
  try {
    const addresses = await resolve(host);
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        return { ok: false, reason: "host " + host + " resolves to a private address (" + address + ")" };
      }
    }
  } catch {
    // 解析失败交给 fetch 去报错，不在这里把 DNS 故障当成安全问题
  }
  return { ok: true };
}

export const MAX_REDIRECTS = 3;
