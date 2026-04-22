import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function getNodeText(node) {
  if (!node) return ''
  if (node.type === 'text' || node.type === 'inlineCode') return node.value || ''
  if (node.children) return node.children.map(getNodeText).join('')
  return ''
}

const itineraryComponents = {
  h1: ({ children }) => (
    <h1 className="text-xl font-bold text-gray-900 mt-8 mb-3 first:mt-0">{children}</h1>
  ),

  h2: ({ children, node }) => {
    const text = getNodeText(node)
    const dayMatch = text.match(/^(Days?\s+[\d–\-]+)\s*[—–\-]+\s*(.+)$/)

    if (dayMatch) {
      const [, dayLabel, rest] = dayMatch
      const pipeIdx = rest.indexOf(' | ')
      const dateStr = pipeIdx >= 0 ? rest.slice(0, pipeIdx).trim() : rest.trim()
      const title   = pipeIdx >= 0 ? rest.slice(pipeIdx + 3).trim() : ''
      return (
        <div className="mt-10 mb-5 first:mt-0">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <span className="px-2.5 py-0.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-xs font-bold rounded-full shrink-0">
              {dayLabel}
            </span>
            {dateStr && <span className="text-xs text-gray-400 font-medium">{dateStr}</span>}
          </div>
          {title && <p className="text-[15px] font-bold text-gray-900">{title}</p>}
          <div className="mt-4 h-px bg-gray-100" />
        </div>
      )
    }

    return (
      <div className="mt-10 mb-4 first:mt-0">
        <h2 className="text-base font-bold text-gray-900">{children}</h2>
        <div className="mt-3 h-px bg-gray-100" />
      </div>
    )
  },

  h3: ({ children }) => (
    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mt-6 mb-2">{children}</h3>
  ),

  p: ({ children }) => (
    <p className="text-[15px] text-gray-700 leading-relaxed mb-3 last:mb-0">{children}</p>
  ),

  ul: ({ children }) => <ul className="mb-4 space-y-2 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-4 space-y-2 last:mb-0">{children}</ol>,

  li: ({ children }) => (
    <li className="flex items-start gap-2.5">
      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-[9px] shrink-0" />
      <span className="text-[15px] text-gray-700 leading-relaxed">{children}</span>
    </li>
  ),

  strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
  em:     ({ children }) => <em className="italic text-gray-500">{children}</em>,

  hr: () => <hr className="border-gray-100 my-8" />,

  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-blue-200 pl-4 my-4 italic text-gray-500 text-sm">{children}</blockquote>
  ),

  code: ({ children, className }) => className
    ? <code className="block bg-slate-50 text-slate-700 px-3 py-2 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre">{children}</code>
    : <code className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded text-xs font-mono">{children}</code>,

  pre: ({ children }) => <pre className="mb-3 rounded-lg overflow-hidden">{children}</pre>,
}

export default function ItineraryContent({ content }) {
  // Strip flag emoji pairs (regional indicator symbols) — they render as "CO", "JP" etc. on Windows
  const cleaned = content.replace(/[\u{1F1E0}-\u{1F1FF}]{2}/gu, '').replace(/  +/g, ' ').trim()
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={itineraryComponents}>
      {cleaned}
    </ReactMarkdown>
  )
}
