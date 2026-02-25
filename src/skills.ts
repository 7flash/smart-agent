// smart-agent/src/skills.ts
// Loads .md skill files (YAML frontmatter + markdown body) via jsx-ai's parseSkillFile
import { parseSkillFile } from "jsx-ai"
import type { SkillMeta } from "jsx-ai"

export type { SkillMeta as Skill }

/** Load skills from file paths → returns parsed skill metadata */
export async function loadSkills(skills: string[]): Promise<SkillMeta[]> {
    const loaded: SkillMeta[] = []

    for (const path of skills) {
        const file = Bun.file(path)
        if (!(await file.exists())) {
            console.warn(`[smart-agent] Skill file not found: ${path}`)
            continue
        }
        try {
            loaded.push(parseSkillFile(path))
        } catch (err) {
            console.warn(`[smart-agent] Failed to parse skill: ${path}`, err)
        }
    }

    return loaded
}

/** Format loaded skills into a system prompt section */
export function formatSkillsForPrompt(skills: SkillMeta[]): string {
    if (skills.length === 0) return ""

    const sections = skills.map(skill =>
        `## ${skill.name}\n${skill.description ? skill.description + '\n' : ''}\n${skill.content}`
    )

    return `\nAVAILABLE SKILLS (use via exec tool):\n\n${sections.join("\n\n---\n\n")}`
}
