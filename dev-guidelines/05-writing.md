# Writing

## Voice

- Neutral and factual. Describe what something **is or does**, in the third person. Never write "I want", "you asked for", "as requested" or similar, in settings text, tooltips, descriptions, popups or the changelog.
- Sentence case for labels and titles ("Level picture", not "Level Picture"). Buttons are short verbs ("Save it", "List the changes", "Choose file…").
- Use the typographic apostrophe `’` and quotes `“ ”` in text people read. Straight `'` and `"` only in code.
- Explain consequences where a choice is destructive ("Saving replaces the folder’s save…").
- Errors say what happened and what can be done, without blame ("The packs couldn’t be loaded. Try again in a moment.").

## Setting descriptions

One or two sentences under the name. Say what it changes and, if relevant, what it costs (a request, a download size). Do not repeat the name.

## Command palette

The big text is a short name; the small text beside it says what choosing the result does, with where it is shown:

| Result | Label (big text) | Hint (small text) |
| --- | --- | --- |
| level | ADOMANIA | Opens this level in the Demon List · #390 · Classic |
| personal list entry | ADOMANIA | Opens this entry to edit · Personal list · 53–79% |
| tab | Packs | Opens the Packs tab |
| setting | AREDL API | Opens this setting · Settings › Account |
| changelog | Packs tab | Opens What’s new · app changelog for version 1.1.3 |

Every place the palette can send you needs a short label and a hint like this. Results that would repeat (the same followed level several times) are given one shared key so they appear once.

## Changelog

- Each entry: `['new' | 'improved' | 'fixed', text, title]`.
- **Title:** very short (1–4 words), shown in bold. No trailing full stop.
- **Text:** what the feature is or what was wrong, stated plainly; one to three sentences. Dates are DD-MM-YYYY.
- `new` = something that did not exist; `improved` = existing behaviour got better; `fixed` = something was broken.
