// Trigger story.transcircle.org rebuild after a submission is approved
// Writes approved submissions to the story repo, triggering CF Pages deploy

interface Env {
  DB: D1Database
  STORY_REPO_TOKEN?: string // GitHub PAT with repo write access
  STORY_REPO_OWNER?: string
  STORY_REPO_NAME?: string
}

interface ApprovedSubmission {
  id: string
  title: string
  content: string
  category: string
  author_name: string | null
  author_type: string
  created_at: string
  reviewed_at: string
}

const OWNER = 'TransCircle'
const REPO = 'story.transcircle.org'
const DATA_PATH = 'data/submissions.json'

export async function triggerRebuild(env: Env): Promise<boolean> {
  const token = env.STORY_REPO_TOKEN
  if (!token) {
    console.log('No STORY_REPO_TOKEN configured — skipping rebuild trigger')
    return false
  }

  const owner = env.STORY_REPO_OWNER || OWNER
  const repo = env.STORY_REPO_NAME || REPO

  try {
    // 1. Fetch all approved submissions from D1
    const { results } = await env.DB.prepare(
      `SELECT id, title, content, category, author_name, author_type, created_at, reviewed_at
       FROM submissions WHERE status = 'approved' ORDER BY created_at DESC`,
    ).all<ApprovedSubmission>()

    const json = JSON.stringify(results, null, 2)
    const contentEncoded = btoa(json)

    // 2. Get current file SHA (if it exists)
    let sha = ''
    try {
      const fileRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${DATA_PATH}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'TransCircle-Submit',
          },
        },
      )
      if (fileRes.ok) {
        const fileData = await fileRes.json() as { sha?: string }
        sha = fileData.sha || ''
      }
    } catch {
      // File doesn't exist yet — will be created
    }

    // 3. Create or update the file
    const body: {
      message: string
      content: string
      branch?: string
      sha?: string
    } = {
      message: `Update approved submissions [${new Date().toISOString().slice(0, 10)}]`,
      content: contentEncoded,
    }
    if (sha) body.sha = sha

    const putRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${DATA_PATH}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'TransCircle-Submit',
        },
        body: JSON.stringify(body),
      },
    )

    if (!putRes.ok) {
      console.error('Failed to update story repo:', await putRes.text())
      return false
    }

    console.log(`Rebuild triggered: ${results.length} approved submissions written to ${owner}/${repo}`)
    return true
  } catch (err) {
    console.error('Rebuild trigger error:', err)
    return false
  }
}
