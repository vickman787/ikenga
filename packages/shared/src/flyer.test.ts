import { describe, expect, it } from 'vitest';
import { renderFlyerSvg, parseFlyerDesign, flyerHtml } from './flyer.js';
const facts = { businessName: 'Ada’s Kitchen', whatItDoes: 'Food shop in Lagos', services: ['Jollof rice', 'Chicken'], prices: [{ item: 'Jollof rice', price: '₦2,500', listed: true }, { item: 'Chicken', price: '₦2,000', listed: true }], contact: 'Call 0803 123 4567', colours: 'Burgundy and cream' };
const design = { headline: 'Your lunch, sorted.', subheading: 'Jollof rice and chicken in Lagos.', details: 'Monday–Saturday, 9am–8pm', accent: '#742F3E', background: '#FFF8EE' };
describe('Exportable flyer artwork', () => {
    it('keeps confirmed prices and contact in the same printable artwork', () => { const svg = renderFlyerSvg(facts, design); expect(svg).toContain('₦2,500'); expect(svg).toContain('₦2,000'); expect(svg).toContain('0803 123 4567'); expect(svg).toContain('viewBox="0 0 1000 1414"'); expect(flyerHtml(svg)).toContain(svg); });
    it('escapes model text and rejects remote imagery', () => { const svg = renderFlyerSvg({ ...facts, businessName: '<script>bad()</script>' }, design, 'https://example.com/tracker.jpg'); expect(svg).not.toContain('<script>'); expect(svg).not.toContain('tracker.jpg'); expect(svg).toContain('&lt;script&gt;'); });
    it('refuses a price list too long to fit legibly', () => { expect(() => renderFlyerSvg({ ...facts, services: Array.from({ length: 20 }, (_, i) => 'Service ' + i) }, design)).toThrow('14 items'); });
    it('validates the layout instructions and falls back from unsafe colours', () => { expect(parseFlyerDesign(JSON.stringify({ ...design, accent: 'url(https://bad)' }))?.accent).toBe('#742F3E'); expect(parseFlyerDesign('not json')).toBeNull(); });
});
