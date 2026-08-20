// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { scanDangerousPatterns } from './dangerousPatterns';

function descriptions(content: string): string[] {
  return scanDangerousPatterns(content).map((m) => m.description);
}

describe('scanDangerousPatterns', () => {
  it('returns nothing for ordinary, safe code', () => {
    expect(scanDangerousPatterns('function add(a, b) { return a + b; }')).toEqual([]);
  });

  it('flags eval() and the Function() constructor', () => {
    expect(descriptions('eval(userInput)').length).toBe(1);
    expect(descriptions('new Function("return 1")').length).toBe(1);
  });

  it('flags unescaped DOM injection sinks', () => {
    expect(descriptions('el.innerHTML = userInput;').length).toBe(1);
    expect(descriptions('el.outerHTML = userInput;').length).toBe(1);
    expect(descriptions('el.insertAdjacentHTML(pos, userInput);').length).toBe(1);
    expect(descriptions('<div dangerouslySetInnerHTML={{__html: x}} />').length).toBe(1);
    expect(descriptions('document.write(userInput);').length).toBe(1);
  });

  it('flags shell-injection-shaped code across languages', () => {
    expect(descriptions('child_process.exec(`rm ${path}`)').length).toBe(1);
    expect(descriptions('subprocess.run(cmd, shell=True)').length).toBe(1);
    expect(descriptions('os.system(cmd)').length).toBe(1);
    expect(descriptions('exec.Command("sh", "-c", cmd)').length).toBe(1);
  });

  it('flags unsafe deserialization across the pickle family plus yaml', () => {
    expect(descriptions('pickle.load(f)').length).toBe(1);
    expect(descriptions('cloudpickle.loads(data)').length).toBe(1);
    expect(descriptions('marshal.loads(data)').length).toBe(1);
    expect(descriptions('shelve.open("db")').length).toBe(1);
    expect(descriptions('yaml.load(data)').length).toBe(1);
    expect(descriptions('yaml.load(data, Loader=yaml.SafeLoader)').length).toBe(0); // explicitly safe
    expect(descriptions('yaml.unsafe_load(data)').length).toBe(1);
  });

  it('flags disabled TLS verification in JS, Python, and env-var form', () => {
    expect(descriptions('https.request({ rejectUnauthorized: false })').length).toBe(1);
    expect(descriptions('requests.get(url, verify=False)').length).toBe(1);
    expect(descriptions('process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"').length).toBe(1);
  });

  it('flags a hardcoded-looking secret and a private key block', () => {
    expect(descriptions('const apiKey = "sk-abcdefgh12345678";').length).toBe(1);
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----';
    expect(descriptions(pem).length).toBe(1);
    expect(descriptions('AKIAABCDEFGHIJKLMNOP').length).toBe(1);
  });

  it('flags weak crypto choices', () => {
    expect(descriptions('cipher.setAutoPadding(true); AES.MODE_ECB').length).toBe(1);
    expect(descriptions('crypto.createCipher("aes192", key)').length).toBe(1);
  });

  it('flags an unpinned external <script> tag but not one with integrity', () => {
    expect(descriptions('<script src="https://cdn.example.com/lib.js"></script>').length).toBe(1);
    expect(descriptions('<script src="https://cdn.example.com/lib.js" integrity="sha384-abc"></script>').length).toBe(0);
  });

  it('a change can trip more than one pattern at once', () => {
    const content = 'eval(x); el.innerHTML = x;';
    expect(descriptions(content).length).toBe(2);
  });
});
