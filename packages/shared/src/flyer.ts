/** Self-contained flyer artwork: no scripts, external fonts, links or remote images. */
export interface FlyerDesign {
    headline: string;
    subheading: string;
    details: string;
    accent: string;
    background: string;
}
export interface FlyerFacts {
    businessName: string;
    whatItDoes: string;
    services: string[];
    prices: {
        item: string;
        price: string;
        listed: boolean;
    }[];
    contact: string;
    colours: string;
}
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const colour = (s: string, fallback: string) => /^#[0-9a-f]{6}$/i.test(s) ? s : fallback;
export const FLYER_DESIGN_SCHEMA = { type: 'object', additionalProperties: false, properties: { headline: { type: 'string' }, subheading: { type: 'string' }, details: { type: 'string' }, accent: { type: 'string' }, background: { type: 'string' } }, required: ['headline', 'subheading', 'details', 'accent', 'background'] };
export function parseFlyerDesign(text: string): FlyerDesign | null {
    try {
        const d = JSON.parse(text);
        if (!d || !['headline', 'subheading', 'details', 'accent', 'background'].every(k => typeof d[k] === 'string') || d.headline.length > 100 || d.subheading.length > 200 || d.details.length > 300)
            return null;
        return { ...d, accent: colour(d.accent, '#742F3E'), background: colour(d.background, '#FFF8EE') };
    }
    catch {
        return null;
    }
}
function lines(text: string, limit: number): string[] {
    const width = (word: string) => [...word].reduce((n, c) => n + (/[WM@#]/.test(c) ? .95 : /[A-Z]/.test(c) ? .72 : /[il.,'’!|]/.test(c) ? .28 : /[^\x00-\x7f]/.test(c) ? 1 : .56), 0) / .58;
    const result: string[] = [];
    let line = '';
    for (const word of text.trim().split(/\s+/)) {
        if (!word)
            continue;
        if (width(word) > limit) {
            if (line) {
                result.push(line);
                line = '';
            }
            let chunk = "";
            for (const char of word) {
                if (width(chunk + char) > limit) {
                    result.push(chunk);
                    chunk = char;
                }
                else
                    chunk += char;
            }
            if (chunk)
                result.push(chunk);
            continue;
        }
        if (width((line + ' ' + word).trim()) > limit) {
            result.push(line);
            line = word;
        }
        else
            line = (line + ' ' + word).trim();
    }
    if (line)
        result.push(line);
    return result;
}
function label(text: string, x: number, y: number, width: number, size: number, maxLines: number, fill: string, weight = 400): string {
    let wrapped: string[] = [];
    for (; size >= 14; size -= 2) {
        wrapped = lines(text, Math.max(8, Math.floor(width / (size * .58))));
        if (wrapped.length <= maxLines)
            break;
    }
    if (wrapped.length > maxLines)
        throw new Error('The flyer contains more text than can fit legibly. Please shorten it or split it into two designs.');
    return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}">${wrapped.map((line, i) => `<tspan x="${x}" dy="${i ? size * 1.25 : 0}">${escape(line)}</tspan>`).join('')}</text>`;
}
export function renderFlyerSvg(facts: FlyerFacts, design: FlyerDesign, image?: string | null): string {
    let accent = colour(design.accent, '#742F3E');
    let background = colour(design.background, '#FFF8EE');
    const luminance = (hex: string) => { const rgb = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
    while (1.05 / (luminance(accent) + .05) < 4.5)
        accent = '#' + [1, 3, 5].map(at => Math.floor(parseInt(accent.slice(at, at + 2), 16) * .85).toString(16).padStart(2, '0')).join('');
    if (luminance(background) < .75)
        background = '#FFF8EE';
    const prices = [...facts.prices];
    for (const name of facts.services)
        if (!prices.some(p => p.item.toLowerCase() === name.toLowerCase()))
            prices.push({ item: name, price: 'price not listed', listed: false });
    if (prices.length > 14)
        throw new Error('A single flyer supports up to 14 items. Split this price list into separate flyers.');
    const picture = image && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image) ? image : null;
    const top = picture ? 688 : 450;
    const rowHeight = Math.min(68, Math.floor((1140 - top) / Math.max(prices.length, 1)));
    const rows = prices.map((p, i) => { const y = top + i * rowHeight; return `<line x1="64" x2="936" y1="${y + rowHeight - 14}" y2="${y + rowHeight - 14}" stroke="${accent}" stroke-opacity=".16"/>` + label(p.item, 64, y, 595, Math.min(30, rowHeight * .5), rowHeight < 52 ? 1 : 2, '#211C18', 500) + label(p.listed ? p.price : 'price not listed', 710, y, 225, Math.min(30, rowHeight * .5), 2, '#211C18', 700); }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1414" viewBox="0 0 1000 1414" role="img" aria-label="${escape(facts.businessName)} flyer"><rect width="1000" height="1414" fill="${background}"/><rect x="0" y="0" width="20" height="1414" fill="${accent}"/><g font-family="Arial, sans-serif">${label(facts.businessName || design.headline, 64, 112, 870, 72, 2, accent, 700)}${label(design.subheading || facts.whatItDoes, 68, 270, 850, 26, 3, '#211C18')}${picture ? `<defs><clipPath id="photo"><rect x="64" y="360" width="872" height="240" rx="18"/></clipPath></defs><image href="${picture}" x="64" y="360" width="872" height="240" preserveAspectRatio="xMidYMid slice" clip-path="url(#photo)"/>` : ''}${label(design.headline, 64, picture ? 648 : 405, 870, 26, 1, accent, 700)}${rows}<rect x="44" y="1194" width="912" height="176" rx="20" fill="${accent}"/>${label(facts.contact, 70, 1244, 860, 32, 2, '#FFFFFF', 700)}${label(design.details, 70, 1330, 855, 20, 2, '#FFFFFF')}</g></svg>`;
}
export function flyerHtml(svg: string): string { return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;background:#ece9e4}svg{display:block;width:100%;height:auto;max-width:1000px;margin:auto}@page{size:A4;margin:0}@media print{html,body{background:white}svg{width:210mm;height:297mm;max-width:none}}</style></head><body>${svg}</body></html>`; }
