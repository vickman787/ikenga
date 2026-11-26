/** Render the supported report Markdown without executing model HTML. */
export function renderReport(md: string): { __html: string } {
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const rows = md.split(/\r?\n/); let html = '', list: 'ol'|'ul'|null = null;
  const close = () => { if(list){html += '</'+list+'>';list=null;} };
  const cells = (line: string) => line.trim().replace(/^\||\|$/g,'').split('|').map(v=>v.trim());
  for(let i=0;i<rows.length;i++) {
    const line=rows[i].trim();
    if(line.includes('|') && rows[i+1]?.includes('|') && cells(rows[i+1]).every(c=>/^:?-{3,}:?$/.test(c))) {
      close(); const headers=cells(line); i++;
      html+='<div style="overflow-x:auto;margin:24px 0;border:1px solid #dce4d3;border-radius:12px"><table style="width:100%;min-width:460px;border-collapse:collapse;font-size:14px"><thead><tr>'+headers.map(h=>'<th scope="col" style="text-align:left;background:#f0f3eb;padding:14px;border-bottom:1px solid #dce4d3">'+inline(h)+'</th>').join('')+'</tr></thead><tbody>';
      while(rows[i+1]?.trim().includes('|')) {
        const values=cells(rows[++i]);
        html+='<tr>'+headers.map((_,n)=>'<td style="padding:14px;border-bottom:1px solid #e5e9e0;vertical-align:top;line-height:1.65">'+inline(values[n]??'')+'</td>').join('')+'</tr>';
      }
      html+='</tbody></table></div>'; continue;
    }
    const heading=line.match(/^(#{1,3})\s+(.+)$/);
    if(heading){close();const tag=heading[1].length===3?'h3':'h2';html+='<'+tag+' style="font-size:'+(tag==='h3'?19:24)+'px;line-height:1.3;margin:28px 0 12px">'+inline(heading[2])+'</'+tag+'>';continue;}
    const item=line.match(/^(- |\d+\. )(.+)$/);
    if(item){const kind=/^\d/.test(item[1])?'ol':'ul';if(list!==kind){close();list=kind;html+='<'+kind+' style="padding-left:22px;line-height:1.8">';}html+='<li style="margin:8px 0">'+inline(item[2])+'</li>';continue;}
    close();if(!line)continue;
    if(/^([-*_])\1{2,}$/.test(line)){html+='<hr style="border:0;border-top:1px solid #dce4d3;margin:24px 0">';continue;}
    html+='<p style="margin:12px 0;line-height:1.8;overflow-wrap:anywhere">'+inline(line)+'</p>';
  }
  close();return {__html:html};
}
