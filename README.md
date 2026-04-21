# LinkedIn Signal Filter

An AI-powered quality filter for your LinkedIn feed. Evaluates every post for genuine signal vs noise using an LLM and hides the junk — or scores everything visually so you can decide for yourself.

This is a personal proof of concept, not a production tool. It works, it's useful, and it will probably break next time LinkedIn changes their DOM.

![Review mode showing scored posts](screenshots/review-mode.png)

## The Problem

LinkedIn is good at surfacing content that's topically relevant to your interests. The problem is that it treats all topically relevant content as equal. A genuinely insightful post sits alongside dozens of empty "🚀 5 reasons AI will transform everything" posts and they all get served with the same weight.

## The Approach

The Signal Filter adds a quality evaluation layer on top of LinkedIn's existing relevance algorithm. It intercepts your feed, sends each post's text through an LLM with a quality rubric, and applies scores directly to the posts in your feed.

Critically, this is **not AI detection**. Using AI to write content doesn't make it bad. Writing without AI doesn't make it good. The rubric evaluates the content itself — regardless of how it was produced.

## How It Works

1. A [Tampermonkey](https://www.tampermonkey.net/) userscript watches your LinkedIn feed as you scroll
2. New posts are detected, text is extracted, and posts are batched for evaluation
3. Each batch is sent to the OpenAI API with a quality evaluation rubric
4. Scores are applied as colour-coded badges directly on the posts
5. Low-scoring posts are hidden (Filter mode) or dimmed (Review mode)

Promoted posts and image/video-only content are auto-filtered immediately without an API call.

### Modes

- **Filter mode** — low-scoring posts are hidden entirely. Your feed gets shorter and better.
- **Review mode** — everything stays visible, but low-scoring posts are dimmed to ~35% opacity with a red border. Hover to read them. Essential for calibrating your trust in the scoring.

### Scoring

Posts are evaluated on four dimensions (each 1-5), plus an overall score (1-10):

| Dimension | What it measures |
|---|---|
| Specificity | Concrete claims vs vague generalities |
| Original reasoning | Building an argument vs assembling talking points |
| Experiential grounding | First-hand experience vs could-be-written-by-anyone |
| Epistemic honesty | Acknowledges limitations vs pure assertion |

The rubric is early and unrefined — it's a starting point, not a finished product. Posts below the threshold (default 5/10) are filtered. Hover over any score badge to see the dimension breakdown and reasoning.

### Status Panel

A floating panel in the bottom-right shows:
- Posts kept vs filtered
- Overall noise rate
- Current threshold and model
- An expandable drawer logging every filtered post with its score, reason, and text preview

## Installation

### Prerequisites

- [Tampermonkey](https://www.tampermonkey.net/) browser extension
- An [OpenAI API key](https://platform.openai.com/api-keys)

### Steps

1. Install Tampermonkey for your browser
2. Click the Tampermonkey icon → "Create a new script"
3. Delete the template content and paste the contents of `linkedin-signal-filter.user.js`
4. Save (Ctrl+S)
5. Navigate to your LinkedIn feed
6. Enter your OpenAI API key when prompted (stored locally in Tampermonkey, only sent to OpenAI)

## Configuration

Key settings are at the top of the script in the `CONFIG` object:

| Setting | Default | Description |
|---|---|---|
| `QUALITY_THRESHOLD` | `5` | Posts scoring below this are hidden (1-10) |
| `MODEL` | `gpt-4o-mini` | OpenAI model. Switch to `gpt-4o` for better discrimination |
| `BATCH_SIZE` | `5` | Posts per API call |
| `DEBOUNCE_MS` | `3000` | Wait time after scroll before evaluating |
| `MIN_TEXT_LENGTH` | `80` | Minimum characters to bother evaluating |
| `MAX_TEXT_LENGTH` | `1500` | Text truncation limit per post |

You can also change settings at runtime via the Tampermonkey menu (right-click the extension icon):
- **Set API Key** — update your OpenAI key
- **Set Quality Threshold** — adjust the filter sensitivity

## Cost

At the time of writing, `gpt-4o-mini` costs roughly $0.15 per million input tokens. A typical scrolling session evaluates maybe 50-100 posts. Actual cost depends on post length and how much you scroll, but expect something in the range of a few cents per session.

## Known Limitations

- **DOM selectors are fragile.** LinkedIn changes their markup regularly. If posts stop being detected, the selectors in `POST_SELECTORS` need updating. The diagnostic approach is documented in the development history.
- **Text-only evaluation.** Image carousels, videos, and infographics can't be evaluated — they're auto-filtered as "no evaluable text."
- **Generic rubric.** The evaluation doesn't know what *you* specifically find valuable. It filters on general quality signals, not personal relevance.
- **No persistence.** Scores aren't saved between sessions. Every page load starts fresh.

## Roadmap Ideas

- **Feedback loop** — upvote/downvote buttons on scored posts, collecting disagreements to refine the rubric with few-shot examples
- **Personal knowledge model** — filtering based on what you already know, not just topic keywords
- **Novelty detection** — filtering on semantic novelty rather than just quality
- **Cross-platform** — the evaluation approach isn't LinkedIn-specific

## Background

This was built in a single conversation with Claude, iterating through DOM debugging, selector updates, and UI refinements. The full story is in the accompanying article: [I Built an AI-Powered Noise Filter for LinkedIn](#) *(link to your LinkedIn article)*.

## Licence

MIT
