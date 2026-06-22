/**
 * Status Message Parser
 *
 * Parses and translates status messages from the backend,
 * extracting structured information from RAG routing packets.
 *
 * The stage field determines the phase (routing, retrieval, initialization, etc.)
 * The content field contains structured data in "key:value" format
 */

import { TFunction } from 'i18next';

interface ParsedStatusMessage {
    translatedContent: string;
    stage: string;
    metadata?: {
        strategy?: string;
        complexity?: string;
        confidence?: string;
        latency?: string;
        queryType?: string;
        count?: string;
        sources?: string;
        target?: string;
        intent?: string;
    };
}

/**
 * Parse and translate status message content based on stage and content structure
 * @param content - The content string (contains status_code or custom message)
 * @param stage - The stage field from the packet
 * @param t - Translation function
 */
export function parseStatusMessage(
    content: string,
    stage: string,
    t: TFunction
): ParsedStatusMessage {
    // Strategy 1: Match content to StatusCode enum values
    // These are the exact values from the backend StatusCode enum
    const statusCodeMapping: Record<string, string> = {
        'deepResearchStarting': 'deepResearch.deepResearchStarting',
        'webSearchStarting': 'webSearchStarting',
        'requestCancelled': 'requestCancelled',
        'initializing': 'initializing',
        'modelLoading': 'modelLoading',
        'modelInitializing': 'modelInitializing',
        'modelReady': 'modelReady',
        'retrieving_documents': 'retrieving_documents',
        'reranking_documents': 'reranking_documents',
        'generating_response': 'generating_response',
        // Document Q&A (unprocessed documents)
        'documentQaNotIndexed': 'documentQaNotIndexed',
        'documentQaExtractingText': 'documentQaExtractingText',
        'documentQaAnalyzingDocument': 'documentQaAnalyzingDocument',
        'documentQaSearchingPages': 'documentQaSearchingPages',
        'documentQaFoundSections': 'documentQaFoundSections',
        'documentQaGeneratingAnswer': 'documentQaGeneratingAnswer',
    };

    // Check if content matches a known status code
    if (statusCodeMapping[content]) {
        return {
            translatedContent: t(`chat.status.${statusCodeMapping[content]}`),
            stage,
        };
    }

    // Strategy 2: Parse dynamic patterns with parameters

    // Document Q&A searching pages: "documentQaSearchingPages:pageCount"
    if (content.startsWith('documentQaSearchingPages:')) {
        const pageCount = content.substring('documentQaSearchingPages:'.length);
        return {
            translatedContent: t('chat.status.documentQaSearchingPages', { pageCount }),
            stage,
            metadata: { count: pageCount },
        };
    }

    // Document Q&A found sections: "documentQaFoundSections:count"
    if (content.startsWith('documentQaFoundSections:')) {
        const count = content.substring('documentQaFoundSections:'.length);
        return {
            translatedContent: t('chat.status.documentQaFoundSections', { count }),
            stage,
            metadata: { count },
        };
    }

    // Book summary generation progress — backend emits literal English
    // ("Summarizing chapter 1/9: Silencing the Public"). Match the
    // shape, pull n / total / title, and translate. Falls through to
    // the raw text if the pattern doesn't fit so future backend
    // tweaks degrade gracefully.
    const summarizingChapterMatch = /^Summarizing chapter (\d+)\/(\d+):\s*(.*)$/.exec(content);
    if (summarizingChapterMatch) {
        const [, n, total, title] = summarizingChapterMatch;
        return {
            translatedContent: t('chat.status.summarizingChapter', {
                n,
                total,
                title,
                defaultValue: `Summarizing chapter ${n}/${total}: ${title}`,
            }),
            stage,
            metadata: { count: `${n}/${total}` },
        };
    }
    // Sibling progress strings emitted by the same flow.
    if (content === 'Generating book summary') {
        return {
            translatedContent: t('chat.status.generatingBookSummary', {
                defaultValue: 'Generating book summary',
            }),
            stage,
        };
    }
    if (content === 'Combining chapter summaries into book summary') {
        return {
            translatedContent: t('chat.status.combiningChapterSummaries', {
                defaultValue: 'Combining chapter summaries into book summary',
            }),
            stage,
        };
    }

    // Plan preview statuses — backend sends snake_case, i18n keys are camelCase
    const planPreviewMap: Record<string, string> = {
        'analyzing_research_query': 'analyzingResearchQuery',
        'generating_research_plan': 'generatingResearchPlan',
        'saving_research_plan': 'savingResearchPlan',
        'plan_ready_for_review': 'planReadyForReview',
        'generating_plan_preview': 'generatingResearchPlan',
        'decomposing_research_tasks': 'decomposingResearchTasks',
        'initializing_multi_agent_coordination': 'initializingMultiAgentCoordination',
        'starting_phase_5_synthesis_qa': 'startingPhase5SynthesisQa',
    };
    if (planPreviewMap[content]) {
        const translated = t(`chat.status.deepResearch.${planPreviewMap[content]}`, { defaultValue: content.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) });
        return { translatedContent: translated, stage };
    }

    // Deep research initialization: "initializing_deep_research:provider_name"
    if (content.startsWith('initializing_deep_research:')) {
        const provider = content.substring('initializing_deep_research:'.length);
        return {
            translatedContent: t('chat.status.initializing_deep_research', { defaultValue: 'Initializing deep research' }),
            stage,
            metadata: { provider },
        };
    }

    // Deep research status codes with colon suffix — strip the suffix and translate
    if (content.startsWith('starting_deep_research:') || content.startsWith('decomposing_research_tasks') ||
        content.startsWith('starting_phase_5') || content.startsWith('deepResearch.')) {
        // Try i18n key directly (for deepResearch.phases.* format)
        if (content.startsWith('deepResearch.')) {
            const translated = t(content, { defaultValue: '' });
            if (translated && translated !== content) {
                return { translatedContent: translated, stage };
            }
        }
        // Strip colon suffix and translate
        const baseKey = content.split(':')[0];
        const translated = t(`chat.status.${baseKey}`, { defaultValue: baseKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) });
        return { translatedContent: translated, stage };
    }

    // Dynamic retrieval status: "retrieving_documents:strategy_name"
    if (content.startsWith('retrieving_documents:')) {
        const strategyKey = content.substring('retrieving_documents:'.length);
        const translationKey = `settings.ragStrategies.${strategyKey}.label`;
        const strategyLabel = t(translationKey, { defaultValue: strategyKey });
        return {
            translatedContent: t('chat.status.retrievingDocumentsWithStrategy', { strategy: strategyLabel }),
            stage,
            metadata: { strategy: strategyKey },
        };
    }

    // Intent analysis pattern: "Intent analysis: {intent_type} (complexity {complexity}) → {strategy}"
    const intentMatch = content.match(/Intent analysis: (.+) \(complexity (.+)\) → (.+)/);
    if (intentMatch) {
        return {
            translatedContent: t('chat.status.intentAnalysis', {
                intent_type: intentMatch[1],
                complexity: intentMatch[2],
                strategy: intentMatch[3]
            }),
            stage,
        };
    }

    // Shared intent analysis: "Shared intent analysis applied: {intent_type} → {strategy}"
    const sharedIntentMatch = content.match(/Shared intent analysis applied: (.+) → (.+)/);
    if (sharedIntentMatch) {
        return {
            translatedContent: t('chat.status.sharedIntentAnalysis', {
                intent_type: sharedIntentMatch[1],
                strategy: sharedIntentMatch[2]
            }),
            stage,
        };
    }

    // Intelligent routing: "Intelligent routing: {sources} → Enhanced RAG"
    const routingMatch = content.match(/Intelligent routing: (.+) → Enhanced RAG/);
    if (routingMatch) {
        return {
            translatedContent: t('chat.status.intelligentRouting', { sources: routingMatch[1] }),
            stage,
        };
    }

    // Strategy 3: Match known custom strings
    const customStringMapping: Record<string, string> = {
        'Connecting to local AI service...': 'connectingLocalAI',
        'Initializing system AI model...': 'initializingSystemAI',
        'Connecting to AI provider...': 'connectingRemoteAI',
    };

    if (customStringMapping[content]) {
        return {
            translatedContent: t(`chat.status.${customStringMapping[content]}`),
            stage,
        };
    }
    // Stage-based translation keys
    const stageLabels: Record<string, string> = {
        'routing': 'routing',
        'routing_strategy': 'routing',
        'routing_reasoning': 'routing',
        'routing_complexity': 'routing',
        'routing_latency': 'routing',
        'initialization': 'initialization',
        'retrieval': 'retrieval',
        'reranking': 'reranking',
        'generation': 'generation',
    };

    // Parse structured content (format: "key:value" or "key:value1,value2")

    // 1. Selected Strategy
    if (content.startsWith('selected_strategy:')) {
        const strategyKey = content.substring('selected_strategy:'.length);
        const translationKey = `settings.ragStrategies.${strategyKey}.label`;
        const strategyLabel = t(translationKey, { defaultValue: strategyKey });

        return {
            translatedContent: t('chat.status.selectedStrategy', { strategy: strategyLabel }),
            stage,
            metadata: { strategy: strategyKey },
        };
    }

    // 2. Reasoning (show truncated version - full reasoning is too long for status)
    if (content.startsWith('reasoning:')) {
        const reasoning = content.substring('reasoning:'.length);
        const truncated = reasoning.length > 100 ? reasoning.substring(0, 100) + '...' : reasoning;
        return {
            translatedContent: t('chat.status.reasoning', { reasoning: truncated }),
            stage,
        };
    }

    // 3. Query Complexity
    if (content.startsWith('complexity:')) {
        const data = content.substring('complexity:'.length);
        const [complexity, queryType] = data.split(',');
        return {
            translatedContent: t('chat.status.queryComplexity', { complexity, queryType: queryType || '' }),
            stage,
            metadata: { complexity, queryType },
        };
    }

    // 4. Expected Latency
    if (content.startsWith('latency:')) {
        const data = content.substring('latency:'.length);
        const [latency, confidence] = data.split(',');
        return {
            translatedContent: t('chat.status.expectedLatency', { latency, confidence }),
            stage,
            metadata: { latency, confidence },
        };
    }

    // 5. Retrieving Documents (with strategy name)
    if (content.startsWith('retrieving_documents:')) {
        const strategyKey = content.substring('retrieving_documents:'.length);
        const translationKey = `settings.ragStrategies.${strategyKey}.label`;
        const strategyLabel = t(translationKey, { defaultValue: strategyKey });

        return {
            translatedContent: t('chat.status.retrievingDocuments', { strategy: strategyLabel }),
            stage,
            metadata: { strategy: strategyKey },
        };
    }

    // 6. Analyzing Collections (with count)
    if (content.startsWith('analyzing_collections:')) {
        const countStr = content.substring('analyzing_collections:'.length);
        const count = parseInt(countStr, 10);
        return {
            translatedContent: t('chat.status.analyzingCollections', { count }),
            stage,
            metadata: { count: countStr },
        };
    }

    // 7. Selected Collections (with count)
    if (content.startsWith('selected_collections:')) {
        const countStr = content.substring('selected_collections:'.length);
        const count = parseInt(countStr, 10);
        return {
            translatedContent: t('chat.status.selectedCollections', { count }),
            stage,
            metadata: { count: countStr },
        };
    }

    // 8. Intelligent Routing (with sources and target)
    if (content.startsWith('intelligent_routing:')) {
        const data = content.substring('intelligent_routing:'.length);
        const parts = data.split(':');
        const sources = parts[0].replace(/,/g, ', '); // Format comma-separated list
        const target = parts[1];

        const key = target === 'direct_llm'
            ? 'intelligentRoutingDirectLlm'
            : 'intelligentRoutingEnhancedRag';

        return {
            translatedContent: t(`chat.status.${key}`, { sources }),
            stage,
            metadata: { sources, target },
        };
    }

    // 9. Intent Analysis (with intent, complexity, strategy)
    if (content.startsWith('intent_analysis:')) {
        const data = content.substring('intent_analysis:'.length);
        const [intent, complexity, strategy] = data.split(',');
        return {
            translatedContent: t('chat.status.intentAnalysis', { intent, complexity, strategy }),
            stage,
            metadata: { intent, complexity, strategy },
        };
    }

    // 10. Shared Intent Analysis (with intent and strategy)
    if (content.startsWith('shared_intent_analysis:')) {
        const data = content.substring('shared_intent_analysis:'.length);
        const [intent, strategy] = data.split(',');
        return {
            translatedContent: t('chat.status.sharedIntentAnalysis', { intent, strategy }),
            stage,
            metadata: { intent, strategy },
        };
    }

    // 11. Context Enhancement (with message)
    if (content.startsWith('context_enhancement:')) {
        const message = content.substring('context_enhancement:'.length);
        return {
            translatedContent: t('chat.status.contextEnhancement', { message }),
            stage,
            metadata: { message },
        };
    }

    // 12. Simple status keys (no parameters)
    const simpleStatusKeys: Record<string, string> = {
        'analyzing_query': 'analyzingQuery',
        'initializing': 'initializing',
        'generating_response': 'generatingResponse',
        'rewriting_query': 'rewritingQuery',
        'query_rewrite_failed': 'queryRewriteFailed',
        'reranking_documents': 'rerankingDocuments',
        'generating_query_transformations': 'generatingQueryTransformations',
        'query_transformation_failed': 'queryTransformationFailed',
        'connecting_local_ai': 'connecting_local_ai',
        'initializing_system_ai': 'initializing_system_ai',
        'connecting_ai_provider': 'connecting_ai_provider',
    };

    if (simpleStatusKeys[content]) {
        return {
            translatedContent: t(`chat.status.${simpleStatusKeys[content]}`),
            stage,
        };
    }

    // 7. Legacy patterns (for backward compatibility)
    if (content.includes('Analyzing query to select optimal RAG strategy')) {
        return {
            translatedContent: t('chat.status.analyzingQuery'),
            stage,
        };
    }

    const strategyMatch = content.match(/🎯 Selected [Ss]trategy: (.+)/);
    if (strategyMatch) {
        return {
            translatedContent: t('chat.status.selectedStrategy', { strategy: strategyMatch[1] }),
            stage,
            metadata: { strategy: strategyMatch[1] },
        };
    }

    // Default: return stage label + content
    const stageLabel = stageLabels[stage] ? t(`chat.status.stage.${stageLabels[stage]}`) : stage;
    return {
        translatedContent: `${stageLabel}: ${content}`,
        stage,
    };
}
