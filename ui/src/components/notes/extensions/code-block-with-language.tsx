/**
 * Custom Code Block Extension with Language Selector and Mermaid Preview
 * Adds syntax highlighting and mermaid diagram rendering
 */

import { Node, mergeAttributes, type NodeViewProps } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent } from '@tiptap/react';
import React, { useState, useEffect } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import mermaid from 'mermaid';
import { Code, Eye, Download, Copy, Check } from 'lucide-react';

// Initialize mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
});

const SUPPORTED_LANGUAGES = [
  { value: 'html', label: 'HTML' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'java', label: 'Java' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'mermaid', label: 'Mermaid' },
  { value: 'python', label: 'Python' },
  { value: 'properties', label: 'Properties' },
  { value: 'yaml', label: 'YAML' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'xml', label: 'XML' },
];

const CodeBlockComponent: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  selected: _selected,
}) => {
  const language = node.attrs.language || 'javascript';
  const [showPreview, setShowPreview] = useState(language === 'mermaid');
  const [mermaidSvg, setMermaidSvg] = useState<string>('');
  const [mermaidError, setMermaidError] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(
    document.documentElement.classList.contains('dark')
  );
  // 7.10 — copy-code feedback. Flips to Check for 1.5s after a successful
  // clipboard write, then reverts. Failed copies leave the icon as Copy.
  const [copied, setCopied] = useState(false);

  // Get the text content from the node
  const getCodeContent = () => {
    return node.textContent || '';
  };

  // Watch for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  const handleLanguageChange = (newLanguage: string) => {
    updateAttributes({ language: newLanguage });
    // Automatically show preview for mermaid, hide for other languages
    setShowPreview(newLanguage === 'mermaid');
  };

  // Render mermaid diagram
  useEffect(() => {
    if (language === 'mermaid' && showPreview) {
      const code = getCodeContent();
      if (!code.trim()) {
        setMermaidError('No mermaid code to render');
        return;
      }

      const renderDiagram = async () => {
        try {
          // Reinitialize mermaid with custom colors for dark mode
          mermaid.initialize({
            startOnLoad: false,
            theme: 'default',
            themeVariables: isDarkMode ? {
              // Text on arrows and messages (no background) - white
              labelTextColor: '#ffffff',
              messageTextColor: '#ffffff',
              loopTextColor: '#ffffff',
              activationBorderColor: '#ffffff',
              // Text inside boxes with light backgrounds - keep dark
              actorTextColor: '#000000',
              noteTextColor: '#000000',
              // Keep colorful boxes as default
            } : {},
            securityLevel: 'loose',
          });

          const id = `mermaid-${Math.random().toString(36).slice(2, 11)}`;
          const { svg } = await mermaid.render(id, code);
          setMermaidSvg(svg);
          setMermaidError('');
        } catch (error) {
          console.error('Mermaid rendering error:', error);
          setMermaidError(error instanceof Error ? error.message : 'Failed to render diagram');
          setMermaidSvg('');
        }
      };

      void renderDiagram();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [language, showPreview, node.textContent, isDarkMode]);

  const handleCopyCode = async () => {
    const text = getCodeContent();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail under strict permissions / iframe; fall
      // back to legacy execCommand so the action still succeeds.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        /* swallow — best effort */
      }
    }
  };

  const handleDownloadSvg = () => {
    if (!mermaidSvg) return;

    const blob = new Blob([mermaidSvg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mermaid-diagram.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const codeContent = getCodeContent();

  // Handle Ctrl+A to select only code block content
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();

      // Select all text in the code block
      const selection = window.getSelection();
      const range = document.createRange();
      const codeElement = e.currentTarget.querySelector('code');

      if (codeElement && selection) {
        range.selectNodeContents(codeElement);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  };

  return (
    <NodeViewWrapper className="code-block-wrapper relative group">
      <div className="relative" onKeyDown={handleKeyDown}>
        {/* Top Right Controls - Always visible on mobile, hover on desktop */}
        <div
          className="absolute top-2 right-2 z-50 flex items-center gap-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
          }}
          onTouchStart={(e) => {
            e.stopPropagation();
          }}
        >
          {/* Mermaid Preview Buttons */}
          {language === 'mermaid' && (
            <div className="flex items-center gap-1 bg-gray-100 dark:bg-[#2a2a2a] rounded-md p-1 shadow-lg">
              <Button
                size="sm"
                variant={!showPreview ? 'default' : 'ghost'}
                className="h-7 px-2 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100"
                onClick={() => setShowPreview(false)}
              >
                <Code className="w-3 h-3 mr-1" />
                Code
              </Button>
              <Button
                size="sm"
                variant={showPreview ? 'default' : 'ghost'}
                className="h-7 px-2 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100"
                onClick={() => setShowPreview(true)}
              >
                <Eye className="w-3 h-3 mr-1" />
                Preview
              </Button>
              {showPreview && mermaidSvg && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100"
                  onClick={handleDownloadSvg}
                >
                  <Download className="w-3 h-3" />
                </Button>
              )}
            </div>
          )}

          {/* 7.10 — Copy code button (always shown, hover-revealed via the
              parent group-hover). On success the icon flips to Check for
              1.5s. Disabled when there's no code yet so the user gets a
              visual hint. */}
          <Button
            size="sm"
            variant="ghost"
            type="button"
            aria-label={copied ? 'Code copied' : 'Copy code'}
            title={copied ? 'Copied' : 'Copy code'}
            disabled={!getCodeContent()}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              void handleCopyCode();
            }}
            className="h-8 px-2 bg-gray-100 dark:bg-[#2a2a2a] text-gray-900 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-[#333333] transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </Button>

          {/* Language Selector */}
          <Select value={language} onValueChange={handleLanguageChange}>
            <SelectTrigger className="h-8 px-3 text-sm bg-gray-100 dark:bg-[#2a2a2a] text-gray-900 dark:text-gray-200 border-none rounded-md shadow-sm hover:bg-gray-200 dark:hover:bg-[#333333] transition-colors">
              <SelectValue placeholder="Language" />
            </SelectTrigger>
            <SelectContent
              className="z-[10050] bg-white dark:bg-[#2a2a2a] border-gray-200 dark:border-gray-700 notes-popover"
              data-notes-popover="true"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <SelectItem
                  key={lang.value}
                  value={lang.value}
                  className="text-sm text-gray-900 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-[#333333] focus:bg-gray-100 dark:focus:bg-[#333333]"
                >
                  {lang.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Code Block Content */}
        {language === 'mermaid' && showPreview ? (
          // Mermaid Preview
          <div className="bg-[#e8e8e8] dark:bg-[#1e1e1e] p-4 overflow-x-auto rounded-[4px]">
            {mermaidError ? (
              <div className="text-red-500 text-sm">
                <strong>Mermaid Error:</strong> {mermaidError}
              </div>
            ) : mermaidSvg ? (
              <div
                className="mermaid-preview flex items-center justify-center"
                dangerouslySetInnerHTML={{ __html: mermaidSvg }}
              />
            ) : (
              <div className="text-muted-foreground text-sm">Rendering diagram...</div>
            )}
          </div>
        ) : (
          // Code Block with Syntax Highlighting
          <div
            className="relative cursor-text"
            onClick={() => {
              if (!isEditing) {
                setIsEditing(true);
                // Focus the code element after a brief delay to ensure rendering
                setTimeout(() => {
                  const codeElement = document.querySelector(`[data-language="${language}"] code`);
                  if (codeElement instanceof HTMLElement) {
                    codeElement.focus();
                  }
                }, 10);
              }
            }}
          >
            {/* Syntax-highlighted overlay (always visible) */}
            {codeContent && (
              <div className="absolute inset-0 pointer-events-none z-10">
                <SyntaxHighlighter
                  language={language}
                  style={isDarkMode ? vscDarkPlus : vs}
                  customStyle={{
                    margin: 0,
                    padding: '1rem 1rem 0 1rem',
                    background: 'transparent',
                    textShadow: 'none',
                    fontSize: '0.875rem',
                    borderRadius: '4px',
                  }}
                  codeTagProps={{
                    style: {
                      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace",
                    }
                  }}
                >
                  {codeContent}
                </SyntaxHighlighter>
              </div>
            )}

            {/* Editable code */}
            <pre
              className="bg-[#e8e8e8] dark:bg-[#1e1e1e] px-4 pt-4 pb-4 overflow-x-auto overflow-y-hidden relative"
              style={{ borderRadius: '4px' }}
              data-language={language}
            >
              <NodeViewContent
                as="code"
                className="editable-code-content block w-full font-mono text-sm outline-none"
                style={{
                  fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace",
                  color: 'transparent',
                  caretColor: isDarkMode ? '#ffffff' : '#000000',
                }}
                onFocus={() => setIsEditing(true)}
                onBlur={() => setIsEditing(false)}
              />
            </pre>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
};

export const CodeBlockWithLanguage = Node.create({
  name: 'codeBlock',

  group: 'block',

  content: 'text*',

  marks: '',

  code: true,

  defining: true,

  addAttributes() {
    return {
      language: {
        default: 'javascript',
        parseHTML: element => element.getAttribute('data-language'),
        renderHTML: attributes => {
          if (!attributes.language) {
            return {};
          }
          return {
            'data-language': attributes.language,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'pre',
        preserveWhitespace: 'full',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes), ['code', 0]];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockComponent);
  },

  addCommands() {
    return {
      setCodeBlock: (attributes) => ({ commands }) => {
        return commands.setNode(this.name, attributes);
      },
      toggleCodeBlock: (attributes) => ({ commands }) => {
        return commands.toggleNode(this.name, 'paragraph', attributes);
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Alt-c': () => this.editor.commands.toggleCodeBlock(),

      // Ctrl+A selects only code block content
      'Mod-a': ({ editor }) => {
        const { state } = editor;
        const { selection } = state;
        const { $from } = selection;

        // Check if cursor is inside a code block by walking up the tree
        let depth = $from.depth;
        let node = null;
        let pos = null;

        while (depth > 0) {
          const currentNode = $from.node(depth);
          if (currentNode.type.name === 'codeBlock') {
            node = currentNode;
            pos = $from.before(depth);
            break;
          }
          depth--;
        }

        if (node && pos !== null) {
          // Select all content within the code block
          const from = pos + 1; // Start of content
          const to = pos + node.nodeSize - 1; // End of content
          editor.chain().focus().setTextSelection({ from, to }).run();
          return true; // Prevent default behavior
        }

        return false; // Allow default behavior for non-code blocks
      },

      // Exit code block on triple Enter
      Enter: ({ editor }) => {
        const { state } = editor;
        const { selection } = state;
        const { $from } = selection;

        if ($from.parent.type.name !== 'codeBlock') {
          return false;
        }

        return false;
      },
    };
  },
});
