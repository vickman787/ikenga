import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import JobBriefFields from './JobBriefFields';
describe('Guided brief fields',()=>{
 it('labels required business and contact fields and keeps brand guidance optional',()=>{
  const html=renderToStaticMarkup(<JobBriefFields jobType="website" values={{businessName:'Ada'}} onChange={()=>{}}/>);
  expect(html).toContain('Business name');expect(html).toContain('Contact to show');expect(html).toContain('Brand colours');expect(html).toContain('for="brief-businessName"');expect(html).toContain('required=""');
 });
 it('switches to research questions without requesting a public contact',()=>{
  const html=renderToStaticMarkup(<JobBriefFields jobType="market-report" values={{}} onChange={()=>{}}/>);
  expect(html).toContain('Businesses or market to research');expect(html).toContain('Location and time period');expect(html).not.toContain('Contact to show');
 });
});
