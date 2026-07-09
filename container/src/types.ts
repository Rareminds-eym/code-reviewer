/**
 * Review request payload sent from the Cloudflare Worker queue handler
 * to the container's POST /review endpoint.
 */
export interface ReviewRequest {
	repoFullName: string;
	prNumber: number;
	headSha: string;
	title: string;
	prAuthor: string;
	prDescription?: string;
	/** Files allowed to be processed (pre-filtered by Worker .codereview.yml ignores) */
	allowedFiles: string[];
	/** Worker-generated request ID for distributed tracing */
	requestId?: string;
	checkRunId?: number;
}

/**
 * Static analysis finding from oxlint, biome, or semgrep.
 */
export interface StaticFinding {
	tool: 'oxlint' | 'biome' | 'semgrep';
	rule: string;
	message: string;
	file: string;
	line: number;
	column?: number;
	severity: 'error' | 'warning' | 'info';
}

/**
 * The blast radius output from the AST graph analyzer.
 */
export interface BlastRadius {
	/** Files directly modified in the PR */
	changedFiles: string[];
	/** Files that import/depend on changed files (transitive) */
	impactedFiles: string[];
	/** Symbols (functions, classes, interfaces) that were modified */
	changedSymbols: SymbolInfo[];
	/** Symbols that reference the changed symbols */
	impactedSymbols: SymbolInfo[];
}

export interface SymbolInfo {
	name: string;
	kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'enum';
	file: string;
	startLine: number;
	endLine: number;
}

/**
 * Finding produced by the LLM reviews (Map phase).
 */
export interface UnifiedFinding {
	severity: 'critical' | 'high' | 'medium' | 'low';
	file: string;
	line?: number;
	title: string;
	issue: string;
	currentCode?: string;
	category: string;
}

/**
 * Response payload returned by the container to the Worker.
 */
export interface ReviewResponse {
	staticFindings: StaticFinding[];
	blastRadius: BlastRadius;
	metrics: ReviewMetrics;
	review?: string;           // LLM-generated review text
	verdict?: 'approve' | 'comment' | 'request_changes' | 'pending';
	findings?: UnifiedFinding[];
	failedChunks?: number;
	totalChunks?: number;
	requestId?: string;
	/** Build gate failed — pipeline terminated before LLM calls */
	buildFailed?: boolean;
	/** Captured build error logs */
	buildErrorLog?: string;
}

export interface ReviewMetrics {
	cloneTimeMs: number;
	parseTimeMs: number;
	staticAnalysisTimeMs: number;
	totalTimeMs: number;
	filesAnalyzed: number;
	symbolsTracked: number;
}


