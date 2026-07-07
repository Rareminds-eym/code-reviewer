/**
 * Progressive Chunking System
 * 
 * Safely splits large source code files along natural AST boundaries (functions, classes)
 * to maintain context for the AI reviewer.
 */

export interface ChunkingConfig {
    baseChunkSize: number;
    minChunkSize: number;
    maxChunkSize: number;
    overlapSize: number;
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
    baseChunkSize: 8000,
    minChunkSize: 4000,
    maxChunkSize: 12000,
    overlapSize: 500,
};

/**
 * Chunk content with progressive sizing and smart boundaries.
 */
export function createProgressiveChunks(
    content: string,
    chunkSize: number,
    overlapSize: number = DEFAULT_CHUNKING_CONFIG.overlapSize
): string[] {
    const chunks: string[] = [];

    // Try to find natural break points (functions, classes, etc.)
    const breakPoints = findNaturalBreakPoints(content);

    let position = 0;
    while (position < content.length) {
        // Calculate end position
        let endPosition = position + chunkSize;

        // Adjust to nearest break point if within tolerance (10% of chunk size)
        const tolerance = chunkSize * 0.1;
        for (const breakPoint of breakPoints) {
            if (breakPoint > position && breakPoint < endPosition + tolerance) {
                // Prefer break point if it's not too far from ideal end
                if (Math.abs(breakPoint - endPosition) < tolerance) {
                    endPosition = breakPoint;
                    break;
                }
            }
        }

        // Ensure we don't exceed content length
        endPosition = Math.min(endPosition, content.length);

        // Extract chunk
        const chunk = content.slice(position, endPosition);
        chunks.push(chunk);

        // Move position with overlap
        position = endPosition - overlapSize;

        // Prevent infinite loop on small remaining content
        // If the chunk reached the end of the file, we are done
        if (endPosition >= content.length) {
            break;
        }
    }

    return chunks;
}

/**
 * Find natural break points in code (function/class boundaries).
 */
function findNaturalBreakPoints(content: string): number[] {
    const breakPoints: number[] = [];

    // Common patterns that indicate good break points
    const patterns = [
        /\n\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type)\s+/g,
        /\n\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
        /\n\s*(?:describe|it|test|before|after)\s*\(/g, // Test blocks
        /\n\s*\/\*\*/g, // JSDoc comments
        /\n\s*##?\s+/g, // Markdown headers
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
            breakPoints.push(match.index);
        }
    }

    // Sort and deduplicate
    return [...new Set(breakPoints)].sort((a, b) => a - b);
}
