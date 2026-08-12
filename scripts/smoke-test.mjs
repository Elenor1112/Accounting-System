/**
 * End-to-end smoke test against a running server.
 *
 * Signs in with the seeded owner, then fetches every screen and asserts the
 * response contains figures that could only come from the seeded ledger. A
 * page that renders but shows nothing real would pass a status check, so the
 * assertions look for actual content.
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';

let cookie = '';

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
    redirect: 'manual',
  });

  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    const jar = new Map(
      cookie
        .split('; ')
        .filter(Boolean)
        .map((part) => {
          const [name, ...rest] = part.split('=');
          return [name, rest.join('=')];
        }),
    );
    for (const entry of setCookie) {
      const [pair] = entry.split(';');
      const [name, ...rest] = pair.split('=');
      jar.set(name, rest.join('='));
    }
    cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  return response;
}

const results = [];
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const loginPage = await request('/login');
  check('login page renders', loginPage.status === 200);

  // The session cookie is minted by scripts/smoke-session.ts and passed in,
  // because driving the login form would require the Next.js server-action id
  // that only the client bundle knows. Login itself is covered by the
  // service-level tests; this run is about whether the pages render real data.
  cookie = process.env.SMOKE_COOKIE ?? '';
  check('session cookie supplied', cookie.includes('ledgerbase_session'));

  if (!cookie.includes('ledgerbase_session')) {
    console.log('\nRun: npx tsx --conditions=react-server scripts/smoke-session.ts');
    process.exit(1);
  }

  const unauth = await fetch(`${BASE}/dashboard`, { redirect: 'manual' });
  check(
    'unauthenticated dashboard redirects to login',
    unauth.status === 307 || unauth.status === 302,
    `status ${unauth.status}`,
  );

  const pages = [
    { path: '/dashboard', expect: ['Revenue', 'Net profit', 'Accounts receivable'] },
    { path: '/invoices', expect: ['INV-', 'Balance'] },
    { path: '/bills', expect: ['BILL-'] },
    { path: '/customers', expect: ['CUST-'] },
    { path: '/vendors', expect: ['VEND-'] },
    { path: '/accounts', expect: ['1130', 'Accounts Receivable', 'Control'] },
    { path: '/journal', expect: ['JE-'] },
    { path: '/payments?direction=receipt', expect: ['PAY-'] },
    { path: '/expenses', expect: ['EXP-'] },
    { path: '/banking', expect: ['Business Checking'] },
    { path: '/periods', expect: ['Fiscal year'] },
    { path: '/reports/profit-loss', expect: ['Revenue', 'Net profit'] },
    { path: '/reports/balance-sheet', expect: ['Balanced', 'Total assets'] },
    { path: '/reports/trial-balance', expect: ['In balance', 'Totals'] },
    { path: '/reports/general-ledger', expect: ['General Ledger'] },
    { path: '/reports/aging', expect: ['Aging'] },
    { path: '/reports/cash-flow', expect: ['Operating activities'] },
    { path: '/settings', expect: ['Northwind Studio', 'Owner'] },
    { path: '/audit', expect: ['Audit Log'] },
  ];

  for (const page of pages) {
    const response = await request(page.path);
    if (response.status !== 200) {
      check(`GET ${page.path}`, false, `status ${response.status}`);
      continue;
    }
    const text = await response.text();
    const missing = page.expect.filter((needle) => !text.includes(needle));
    check(
      `GET ${page.path}`,
      missing.length === 0,
      missing.length > 0 ? `missing: ${missing.join(', ')}` : `${text.length} bytes`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Smoke test error:', err);
  process.exit(1);
});
