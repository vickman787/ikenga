import { expect, it } from 'vitest';
import { renderReport } from './reportPresentation';
it('renders comparison tables and ordered actions with semantic structure',()=>{
 const {__html:html}=renderReport('# Decision\n\n| Option | Cost |\n| --- | ---: |\n| Rice | ₦2,500 |\n\n## Next actions\n1. Confirm costs\n2. Test demand');
 expect(html).toContain('<table');expect(html).toContain('<th scope="col"');expect(html).toContain('₦2,500');expect(html).toContain('<ol');expect(html).not.toContain('| ---');
});
it('escapes customer HTML and quote characters in source URLs',()=>{
 const html=renderReport('<script>alert(1)</script>\n[Source](https://example.test/"bad)\n[Unsafe](javascript:alert(1))').__html;
 expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');expect(html).toContain('href="https://example.test/&quot;bad"');expect(html).not.toContain('href="javascript:');
});
it('does not treat prose or malformed separators as a table',()=>{expect(renderReport('One | two\nNot a table').__html).not.toContain('<table');});
