export {
  EmailClassifier,
  type Classification,
  type ClassificationResult,
  type ClassifierConfig,
  type CorrectionExample,
  type ContentFormat,
} from "./classifier.js";
export { LabelManager } from "./labels.js";
export {
  parseCustomRules,
  applyRules,
  buildConfigFromStore,
  type Rule,
} from "./rules.js";
export {
  TriageEngine,
  type TriageEngineConfig,
  type TriageResult,
} from "./engine.js";
export { CorrectionProcessor } from "./corrections.js";
