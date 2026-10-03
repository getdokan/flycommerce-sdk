import { escapeHtml } from './http.js';

function page(title: string, styles: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${styles}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// Shown in the merchant's own tab after the install redirect, outside the dashboard frame.
const CONNECTED_STYLES = `
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f5f8; color: #0f1729; font: 14px/1.5 Inter, system-ui, sans-serif; }
  main { max-width: 420px; margin: 24px; padding: 28px; background: #fff; border: 1px solid #e6e8ef; border-radius: 12px; box-shadow: 0 1px 2px rgba(16, 23, 41, .05); }
  h1 { margin: 0 0 8px; font-size: 18px; }
  p { margin: 0; color: #475069; }
`;

export function connectedPage(appName: string, store: string): string {
  return page(
    `${appName} connected`,
    CONNECTED_STYLES,
    `<main>
  <h1>${escapeHtml(appName)} is connected</h1>
  <p>It can now work with <strong>${escapeHtml(store)}</strong>. Open it from Apps in your store dashboard.</p>
</main>`
  );
}

// The tab a sign-in finishes in; the dashboard tab picks up the change when the merchant returns to it.
export function noticePage(title: string, message: string, action?: { label: string; href: string }): string {
  return page(
    title,
    `${CONNECTED_STYLES}
  a { display: inline-block; margin-top: 16px; color: #1d4ed8; font-weight: 600; text-decoration: none; }`,
    `<main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  ${action ? `<a href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>` : ''}
</main>`
  );
}
