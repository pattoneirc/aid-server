import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { StudioVideoReferenceErrors } from './StudioVideoReferenceErrors'
import { videoQuoteReferenceIssues } from '@/utils/canvas/canvasVideoQuoteReferenceIssues'

it('renders two explicit error rows and an expand control while retaining the full resource ID', () => {
  const ids = ['912345678901234561', '912345678901234564', '912345678901234566']
  const issues = videoQuoteReferenceIssues({ payload: { data: {
    errorCode: 'VIDEO_QUOTE_REFERENCE_IMAGES_INVALID',
    referenceImageIssues: ids.map((resourceId, index) => ({
      resourceId, index: [1, 4, 6][index], kind: index === 1 ? 'FILE_SIZE' : 'ASPECT_RATIO',
      actual: index === 1 ? 34 : 2.694336, maximum: index === 1 ? 30 : 2.5, width: 2759, height: 1024
    }))
  } } })
  const html = renderToStaticMarkup(createElement(StudioVideoReferenceErrors, {
    groups: issues.map(issue => ({ ...issue, issues: [issue] })),
    onLocate: () => undefined,
    renderAction: () => null
  }))
  expect(html).toContain('2.69:1，最高 2.5:1')
  expect(html).toContain('34 MB，最大 30 MB')
  expect(html).not.toContain('第 6 张')
  expect(html).toContain('查看全部（3 张）')
  expect(issues.map(issue => issue.resourceId)).toEqual(ids)
})
