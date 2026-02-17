/**
 * Heuristic message classifier for model routing.
 * Pure function — no I/O, no API calls. Runs on the host before container spawn.
 */
import {
  COMPLEX_KEYWORD_PATTERNS,
  COMPLEX_MIN_CHARS,
  MULTI_STEP_INDICATORS,
  ROUTER_CONFIG,
  SIMPLE_KEYWORD_PATTERNS,
  SIMPLE_MAX_CHARS,
  TOOL_REQUIRING_PATTERNS,
} from './config.js';

export interface ClassificationResult {
  model: 'claude' | 'gemini';
  complexity: 'simple' | 'complex';
  score: number;
  reason: string;
  signals: string[];
}

export function classifyMessage(
  content: string,
  messageCount: number = 1,
): ClassificationResult {
  if (!ROUTER_CONFIG.enabled) {
    return {
      model: 'claude',
      complexity: 'complex',
      score: 100,
      reason: 'Router disabled',
      signals: [],
    };
  }

  let score = 0;
  const signals: string[] = [];
  const trimmed = content.trim();
  const lineCount = trimmed.split('\n').length;

  // --- Negative signals (simple) ---

  if (trimmed.length < SIMPLE_MAX_CHARS) {
    score -= 15;
    signals.push(`short(${trimmed.length}ch)`);
  }

  for (const pattern of SIMPLE_KEYWORD_PATTERNS) {
    if (pattern.test(trimmed)) {
      score -= 20;
      signals.push('simple-pattern');
      break;
    }
  }

  // Simple question (short + ends with ?)
  if (trimmed.length < 100 && trimmed.endsWith('?') && lineCount === 1) {
    score -= 10;
    signals.push('simple-question');
  }

  // Emoji-only or very short non-alpha content
  const alphaContent = trimmed.replace(/[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
  if (alphaContent.length === 0 && trimmed.length > 0) {
    score -= 20;
    signals.push('emoji-only');
  }

  // --- Positive signals (complex) ---

  if (trimmed.length > COMPLEX_MIN_CHARS) {
    score += 20;
    signals.push(`long(${trimmed.length}ch)`);
  }

  // Code/technical keywords (cap at 3 matches = +45)
  let keywordHits = 0;
  for (const pattern of COMPLEX_KEYWORD_PATTERNS) {
    if (pattern.test(trimmed)) {
      keywordHits++;
      if (keywordHits <= 3) {
        score += 15;
        signals.push(`tech-keyword(${pattern.source.slice(2, 20)})`);
      }
    }
  }

  // Tool-requiring patterns
  for (const pattern of TOOL_REQUIRING_PATTERNS) {
    if (pattern.test(trimmed)) {
      score += 30;
      signals.push('needs-tool');
      break;
    }
  }

  // Code blocks
  if (/```/.test(trimmed)) {
    score += 25;
    signals.push('code-block');
  }

  // Multi-step instructions
  let multiStepHits = 0;
  for (const pattern of MULTI_STEP_INDICATORS) {
    if (pattern.test(trimmed)) {
      multiStepHits++;
    }
  }
  if (multiStepHits >= 2) {
    score += 20;
    signals.push('multi-step');
  }

  // Multiline (5+ lines)
  if (lineCount >= 5) {
    score += 15;
    signals.push(`multiline(${lineCount})`);
  }

  // Message burst (queued messages indicate complex conversation)
  if (messageCount > 3) {
    score += 10;
    signals.push(`burst(${messageCount})`);
  }

  const isComplex = score >= ROUTER_CONFIG.complexityThreshold;

  return {
    model: isComplex ? 'claude' : 'gemini',
    complexity: isComplex ? 'complex' : 'simple',
    score,
    reason: isComplex
      ? `Score ${score} >= ${ROUTER_CONFIG.complexityThreshold}`
      : `Score ${score} < ${ROUTER_CONFIG.complexityThreshold}`,
    signals,
  };
}
