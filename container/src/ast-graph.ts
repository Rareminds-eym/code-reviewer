import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import type { BlastRadius, SymbolInfo } from './types.js';

// tree-sitter is loaded dynamically since it has native bindings
let Parser: any;
let TypeScript: any;

async function ensureParser(): Promise<void> {
	if (!Parser) {
		const treeSitter = await import('tree-sitter');
		const tsLang = await import('tree-sitter-typescript');
		Parser = treeSitter.default;
		TypeScript = tsLang.default.typescript;
	}
}

/**
 * Build the "blast radius" of a PR by analyzing the AST of changed files
 * and tracing import dependencies to find impacted files.
 *
 * @param workDir - Root directory of the cloned repo
 * @param changedFiles - List of files modified in the PR (relative paths)
 * @returns BlastRadius with changed/impacted files and symbols
 */
export async function buildBlastRadius(workDir: string, changedFiles: string[]): Promise<BlastRadius> {
	await ensureParser();

	const parser = new Parser();
	parser.setLanguage(TypeScript);

	// Extract symbols and imports from changed files
	const changedSymbols: SymbolInfo[] = [];
	const importMap = new Map<string, Set<string>>(); // file -> set of imported file paths

	for (const file of changedFiles) {
		if (!isTypeScriptFile(file)) continue;

		try {
			const content = await readFile(join(workDir, file), 'utf-8');
			const tree = parser.parse(content);

			// Extract symbol definitions from this file
			const symbols = extractSymbols(tree.rootNode, file);
			changedSymbols.push(...symbols);

			// Extract import paths
			const imports = extractImports(tree.rootNode, file, workDir);
			importMap.set(file, imports);
		} catch (err) {
			console.warn(`[ast-graph] Failed to parse ${file}:`, err);
		}
	}

	// Build reverse dependency map: for each file, which files import it?
	const reverseDepMap = new Map<string, Set<string>>();

	// Scan all TS files for imports that reference the changed files
	const allTsFiles = await findTypeScriptFiles(workDir, changedFiles);

	for (const file of allTsFiles) {
		if (changedFiles.includes(file)) continue; // Skip already-analyzed files

		try {
			const content = await readFile(join(workDir, file), 'utf-8');
			const tree = parser.parse(content);
			const imports = extractImports(tree.rootNode, file, workDir);

			for (const importedPath of imports) {
				// Check if this file imports any of our changed files
				const normalizedImport = normalizeImportPath(importedPath);
				for (const changedFile of changedFiles) {
					if (changedFile.includes(normalizedImport) || normalizedImport.includes(changedFile.replace(/\.(ts|tsx)$/, ''))) {
						if (!reverseDepMap.has(changedFile)) {
							reverseDepMap.set(changedFile, new Set());
						}
						reverseDepMap.get(changedFile)!.add(file);
					}
				}
			}
		} catch {
			// Skip files that fail to parse
		}
	}

	// Collect impacted files (files that depend on changed files)
	const impactedFilesSet = new Set<string>();
	for (const deps of reverseDepMap.values()) {
		for (const dep of deps) {
			impactedFilesSet.add(dep);
		}
	}

	// Extract symbols from impacted files
	const impactedSymbols: SymbolInfo[] = [];
	for (const file of impactedFilesSet) {
		try {
			const content = await readFile(join(workDir, file), 'utf-8');
			const tree = parser.parse(content);
			const symbols = extractSymbols(tree.rootNode, file);
			impactedSymbols.push(...symbols);
		} catch {
			// Skip
		}
	}

	return {
		changedFiles,
		impactedFiles: [...impactedFilesSet],
		changedSymbols,
		impactedSymbols,
	};
}

/**
 * Cheap symbol extraction: parse ONLY the changed files and return their symbol
 * definitions. This is the inexpensive half of {@link buildBlastRadius} — it does
 * NOT perform the repo-wide reverse-dependency scan.
 *
 * Used on every review to (a) seed/rank graphify's PR-scoped `affected` queries
 * and (b) summarize changed symbols in the prompt. The expensive reverse-dependency
 * blast radius is delegated to graphify (authoritative) and only computed here via
 * {@link buildBlastRadius} as a fallback when graphify is unavailable (R8).
 */
export async function extractChangedSymbols(workDir: string, changedFiles: string[]): Promise<SymbolInfo[]> {
	await ensureParser();

	const parser = new Parser();
	parser.setLanguage(TypeScript);

	const changedSymbols: SymbolInfo[] = [];
	for (const file of changedFiles) {
		if (!isTypeScriptFile(file)) continue;
		try {
			const content = await readFile(join(workDir, file), 'utf-8');
			const tree = parser.parse(content);
			changedSymbols.push(...extractSymbols(tree.rootNode, file));
		} catch (err) {
			console.warn(`[ast-graph] Failed to parse ${file}:`, err);
		}
	}
	return changedSymbols;
}

/**
 * Extract symbol definitions (functions, classes, interfaces, types) from an AST node.
 */
function extractSymbols(rootNode: any, file: string): SymbolInfo[] {
	const symbols: SymbolInfo[] = [];
	const cursor = rootNode.walk();

	function visit(): void {
		const node = cursor.currentNode;
		let name: string | null = null;
		let kind: SymbolInfo['kind'] | null = null;

		switch (node.type) {
			case 'function_declaration':
			case 'method_definition':
				name = node.childForFieldName('name')?.text ?? null;
				kind = 'function';
				break;
			case 'class_declaration':
				name = node.childForFieldName('name')?.text ?? null;
				kind = 'class';
				break;
			case 'interface_declaration':
				name = node.childForFieldName('name')?.text ?? null;
				kind = 'interface';
				break;
			case 'type_alias_declaration':
				name = node.childForFieldName('name')?.text ?? null;
				kind = 'type';
				break;
			case 'enum_declaration':
				name = node.childForFieldName('name')?.text ?? null;
				kind = 'enum';
				break;
			case 'lexical_declaration':
			case 'variable_declaration': {
				// Handle `export const X = ...`
				const declarator = node.namedChildren.find((c: any) => c.type === 'variable_declarator');
				if (declarator) {
					name = declarator.childForFieldName('name')?.text ?? null;
					kind = 'variable';
				}
				break;
			}
		}

		if (name && kind) {
			symbols.push({
				name,
				kind,
				file,
				startLine: node.startPosition.row + 1,
				endLine: node.endPosition.row + 1,
			});
		}

		// Visit children
		if (cursor.gotoFirstChild()) {
			do {
				visit();
			} while (cursor.gotoNextSibling());
			cursor.gotoParent();
		}
	}

	visit();
	return symbols;
}

/**
 * Extract import paths from an AST node.
 */
function extractImports(rootNode: any, fromFile: string, workDir: string): Set<string> {
	const imports = new Set<string>();

	for (const child of rootNode.namedChildren) {
		if (child.type === 'import_statement') {
			const source = child.childForFieldName('source');
			if (source) {
				const importPath = source.text.replace(/['"]/g, '');
				if (importPath.startsWith('.')) {
					// Resolve relative import to absolute within repo
					const resolvedDir = dirname(join(workDir, fromFile));
					const resolved = resolve(resolvedDir, importPath);
					const relative = resolved.replace(workDir + '/', '');
					imports.add(relative);
				}
			}
		}
	}

	return imports;
}

function normalizeImportPath(p: string): string {
	return p.replace(/\.(ts|tsx|js|jsx)$/, '').replace(/\/index$/, '');
}

function isTypeScriptFile(file: string): boolean {
	return /\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts');
}

/**
 * Find all TypeScript files in the repo (limited depth to avoid scanning huge trees).
 */
async function findTypeScriptFiles(workDir: string, changedFiles: string[]): Promise<string[]> {
	// For performance, only scan directories that contain changed files
	const dirsToScan = new Set<string>();
	for (const f of changedFiles) {
		dirsToScan.add(dirname(f));
		// Also scan the parent directory for cross-directory imports
		const parent = dirname(dirname(f));
		if (parent !== '.') dirsToScan.add(parent);
	}

	const results: string[] = [];
	const { execa } = await import('execa');

	for (const dir of dirsToScan) {
		try {
			const result = await execa('find', [join(workDir, dir), '-name', '*.ts', '-o', '-name', '*.tsx', '-maxdepth', '3', '-not', '-path', '*/node_modules/*'], {
				timeout: 10_000,
			});
			const files = result.stdout.split('\n').filter(Boolean).map((f) => f.replace(workDir + '/', ''));
			results.push(...files);
		} catch {
			// Directory might not exist
		}
	}

	return [...new Set(results)];
}
