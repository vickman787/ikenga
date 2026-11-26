import { notFound } from 'next/navigation';
import { renderFlyerSvg } from '@ikenga/shared';
import MediaExports from '@/components/MediaExports';
import Slideshow from '@/components/Slideshow';
export default function Examples() {
    if (process.env.NEXT_PUBLIC_IKENGA_READ_ONLY !== '1')
        notFound();
    const svg = renderFlyerSvg({ businessName: 'Sample Kitchen', whatItDoes: 'Lunch for local businesses', services: ['Jollof rice', 'Fried rice', 'Chicken'], prices: [{ item: 'Jollof rice', price: '₦2,500', listed: true }, { item: 'Fried rice', price: '₦2,500', listed: true }, { item: 'Chicken', price: '₦2,000', listed: true }], contact: 'Order: orders@example.test', colours: 'Burgundy and cream' }, { headline: 'Lunch is sorted.', subheading: 'Jollof rice, fried rice and chicken.', details: 'Sample details for export testing.', accent: '#742F3E', background: '#FFF8EE' });
    const slides = [{ title: 'Sample Kitchen', text: 'Jollof rice, fried rice and chicken.' }, { title: 'Lunch is sorted.', text: 'Jollof rice ₦2,500. Fried rice ₦2,500. Chicken ₦2,000.' }, { title: 'Order lunch', text: 'orders@example.test' }];
    return <main className="wrap" style={{ maxWidth: 1100, paddingBlock: 40 }}><a href="/#hire">← Back to the workspace</a><h1 style={{ fontSize: 36, marginTop: 24 }}>Try the new exports</h1><p style={{ marginTop: 12, lineHeight: 1.6 }}>These are fictional examples for checking the new layouts and downloads. They do not contain customer work or create paid jobs.</p><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,320px),1fr))', gap: 32, marginTop: 32 }}><section><h2>Flyer</h2><p style={{ marginBlock: 12 }}>The preview, PNG and PDF use the same artwork.</p><style>{'.example-flyer svg{width:100%;height:auto;display:block}'}</style><div className="example-flyer" dangerouslySetInnerHTML={{ __html: svg }}/><MediaExports svg={svg}/></section><section><h2>Promo</h2><p style={{ marginBlock: 12 }}>Export these three sample slides as a silent video. Keep this tab visible until it finishes.</p><Slideshow slides={slides}/><MediaExports slides={slides}/></section></div></main>;
}
