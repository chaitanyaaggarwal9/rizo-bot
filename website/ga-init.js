// Google Analytics 4 bootstrap. Kept in a file instead of an inline
// <script> so the Content-Security-Policy in vercel.json can omit
// 'unsafe-inline'. gtag.js itself loads async from googletagmanager.com.
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', 'G-S37XL7PTJH');
