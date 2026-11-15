// The /privacy page renders policy files with set:html, so a policy carrying
// markup must reach the page as text, bold included.
import { expect, test } from "vitest";
import { renderPolicy } from "../src/policy.ts";

test("a policy's HTML is shown as text, even inside bold or code", () => {
  const html = renderPolicy('**<img src=x onerror="alert(1)">** and `<script>x</script>`');
  expect(html).not.toMatch(/<(img|script)/);
  expect(html).toBe(
    "<strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</strong> and <code>&lt;script&gt;x&lt;/script&gt;</code>",
  );
});
