import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Examples from './page';
afterEach(() => vi.unstubAllEnvs());
it('shows export fixtures only in the read-only preview', () => { vi.stubEnv('NEXT_PUBLIC_IKENGA_READ_ONLY', '1'); const html = renderToStaticMarkup(<Examples />); expect(html).toContain('fictional examples'); expect(html).toContain('orders@example.test'); expect(html).toContain('Download PNG'); });
it('does not expose the example page on production', () => { vi.stubEnv('NEXT_PUBLIC_IKENGA_READ_ONLY', '0'); expect(() => Examples()).toThrow(); });
