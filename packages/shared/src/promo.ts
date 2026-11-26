/** Shared palette so the slide preview and exported video have the same art direction. */
export function promoScene(index: number) {
    return [
        { background: '#182C25', ink: '#FFF9EF', accent: '#D4EA8D' },
        { background: '#F3EBDD', ink: '#272A23', accent: '#742F3E' },
        { background: '#742F3E', ink: '#FFF9EF', accent: '#F3CDA5' },
        { background: '#D4EA8D', ink: '#182C25', accent: '#284B3C' },
        { background: '#182C25', ink: '#FFF9EF', accent: '#D4EA8D' },
    ][index % 5];
}
