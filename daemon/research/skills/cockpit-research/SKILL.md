---
name: cockpit-research
description: "Deep research as Cockpit's /research command runs it: web research by parallel subagents, every quote checked against its page, then a sourced report."
hide: true
---
# Deep research

The user's question follows "Deep research:" in their message. You are the lead: you plan, hand the searching to cheap subagents, check what they bring back, and write the report yourself.

## What holds throughout

- Gathering is done by `research-gatherer` subagents, which run on the small model. At most 12 in the first wave and 6 in the second. There is no third wave.
- The report cites a source only if the quote check found its quote on its page.
- Nothing goes in the report from memory. If it is not in a notes file, it is not in the report.
- Keep the todo list and the plan current, as for any large task, and record each choice you make for the user with the plan tool.

## 1. Scope

If the question leaves open something that would change the plan (who the reader is, which country's rules, which period), ask with the `ask` tool, three questions at most. Otherwise start, and say in one sentence what you assumed.

## 2. Set up

Everything for this run goes in `~/research/<slug>/`, where `<slug>` is three to five words of the question in kebab case; add today's date if that directory exists. Use absolute paths from here on.

Split the question into 6 to 12 sub-questions. Make each narrow enough that six to ten sourced findings answer it: one topic, one kind of source. A sub-question that covers several topics comes back thin.

Write `brief.md` there:

```
# Brief

Question: <the user's question>
Reader and scope: <who the report is for, jurisdiction, period, what is out of scope>
Date: <today>

## Sub-questions

1. <sub-question> → <absolute path>/sources/1-<slug>.md
2. …
```

## 3. First wave

Start one `research-gatherer` per sub-question, all in one `task` call. Each task gives the brief's path, the sub-question's number and text, its notes file, what to cover, and any sources you already know to look for. The gatherers know the notes format and the sourcing rules.

## 4. Check the notes

When the gatherers are done, run the quote check. It is a module beside this file, which you call from your `eval` tool with your own read tool, so that it reads pages as you do.

First find where this skill is, with `bash`:

```
realpath skill://cockpit-research
```

Then, in `eval` with `language: "js"` (allow it ten minutes), with that directory and the run's:

```js
const { quoteCheck } = await import('<skill directory>/quote-check.js');
print(await quoteCheck('<run directory>', (path) => tool.read({ path })));
```

It reads every notes file in `sources/`, reads each cited page again, and looks for each quoted passage on it. It writes `sources/quote-check.md` and prints what needs you:

- **verbatim**: every passage is on the page word for word. Citable.
- **near**: most of the wording is there, broken by something the comparison does not see through (a footnote mark, a damaged word in a PDF, words left out without `...`). Read the page text printed beside the quote, and cite the finding only if the page says the same.
- **not found**: a passage is not on the page as written. Often the Quote line holds the gatherer's own words around a real passage: if the page text printed beside it has the passage, correct the Quote line in the notes file so that it holds only the passage (the rest goes in `Note:`), and run the check again. Otherwise not citable.
- **page not fetched**: the site refused. Not citable.
- **incomplete**: the finding has no URL or no quote. Not citable.
- **WITHDRAWN**: arXiv marks the paper withdrawn. Cite it only to say so.

Then read the notes themselves, with their "Conflicts" and "Not found" sections.

## 5. Fill the gaps

List what the answer will rest on that is weak: a claim with one source, a conflict between sources, a missing piece the reader needs, a page that was not fetched, a result about an AI model more than a year old.

- Where a gatherer named a source it could not open, try it yourself, and other copies of it. Write what you find to `sources/lead.md` in the gatherers' format (`### claim`, then `- Source:`, `- URL:`, `- Quote:`, `- Kind:`, `- Note:` lines), so the check covers it.
- For the rest, start a second wave of gatherers, on the gaps only.

Then stop gathering. What is still missing goes in the report as missing.

## 6. Check the sources the answer rests on

Pick the five to ten sources that carry the answer. For each, find out whether it still stands: withdrawn, retracted, superseded, replaced by a later version, or failed to replicate. Open the source's own page and search for its title with those words. The quote check flags withdrawn arXiv papers; everything else is yours. Record what you find in `sources/lead.md`. A gatherer on a small model will quote a retracted paper without noticing.

Run the quote check again.

## 7. Write the report

Write `report.md` in the run's directory:

1. **The answer**, first, in a few numbered points a reader can act on.
2. **How to read it**: what the confidence notes mean, and what you assumed about the reader.
3. **Findings**, by topic. Each states the claim, links its source inline, quotes sparingly, and ends with a confidence note and the reason for it:
   - High: an official body's own text, or a peer-reviewed study with its sample stated.
   - Medium: a working paper, a single study, an abstract only, or evidence from another field.
   - Low: a practitioner's view with no test, a vendor survey, or press.
4. **What remains open**: what was looked for and not found, and where sources disagree.
5. **Method**: how many gatherers ran, how many findings and pages were checked, and the counts from `sources/quote-check.md`, with one sentence on what the check does not show (that a study is right).

Say plainly where a common belief has no evidence behind it, and where the evidence comes from another field. Give every number its sample and period.

Run the quote check a last time. It lists the links in `report.md` that no checked finding backs: fix each (add the finding to `sources/lead.md`, or drop the citation) until there are none.

## 8. Tell the user

Reply with the report's absolute path (it opens in a file window with a click), the answer in a few lines, what remains open, and the check's counts. Mention anything you found withdrawn or retracted.
