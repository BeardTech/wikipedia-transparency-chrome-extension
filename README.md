# Wikipedia Transparency (Chrome Extension)

`Wikipedia Transparency` displays reliability signals directly on Wikipedia article pages.
The extension only runs on real article pages (main namespace), not on special/project/user/talk pages.

## What The Extension Does

- Adds a discreet banner at the top of the page with:
  - trust score (0-100)
  - risk level (low/moderate/high)
  - total page revisions (without loading full history)
  - score base (number of revisions actually used for the score)
  - a quick metrics summary
  - a "why" explanation when the score drops
  - 3 latest contributors with links to their profile and their diff
  - detected Wikipedia quality label (Featured article / Good article / none)
  - top 5 contributors (added words) with links to their contribution pages
  - contributor level next to top contributors (recognized / established / intermediate / new)
- Explicitly handles sensitive cases:
  - strong score decrease when there is high activity/conflict over 3 months
  - strong score decrease for very recent pages with little history
  - score decrease when recent edits are dominated by very new accounts
  - score increase when top contributors are mostly recognized contributors

## How The Score Is Calculated

The trust score is a 0-100 score.

- Starting base: `80`
- Bonuses:
  - `+8` if at least `40` unique contributors
  - `+4` if at least `100` unique contributors
  - `+8` if the article is highly distributed (`>=200` revisions, `>=80` contributors, and top contributor share < `12%`)
  - `+10` if recognized contributors represent at least `55%` of top-author added content
  - `+6` if recognized contributors represent at least `45%` of edits in the last 90 days (`>=20` edits in window)
- Penalties:
  - `-14` if the top contributor exceeds `22%` of revisions
  - additional `-8` if they exceed `35%`
  - `-8` if more than `30%` of edits are anonymous
  - `-14` if reverts exceed `18%`
  - additional `-8` if reverts exceed `30%`
  - `-8` if controversy comments exceed `10%`
  - `-10` if more than `55%` of edits happened in the last 30 days
  - `-14` if recognized contributors represent less than `25%` of top-author added content (with at least 3 top contributors)
  - `-12` if edits by very new accounts are at least `35%` of edits in the last 90 days (`>=20` edits in window)
  - additional `-8` if edits by very new accounts are at least `55%` (`>=35` edits in window)
- Recent-page cases:
  - strong penalty if the page is recent and has little history (e.g., fewer than 20 revisions within 30 days)
- "Edit war" case (3-month window):
  - penalty for high recent activity
  - penalty for sudden acceleration vs the previous 3 months
  - penalty for many recent reverts
- Contributor-level signal:
  - users are classified with Wikipedia account metadata (`editcount`, `registration`, `groups`)
  - trusted/recognized levels are rewarded when they dominate main authorship
  - low-experience/new accounts are penalized when dominating recent activity

The final score is clamped between `0` and `100`, then mapped to levels:
- `Low risk` if score `>= 70`
- `Moderate risk` if score `< 70`
- `High risk` if score `< 50`

## Technical Notes

- API safeguards:
  - score limited to 300 revisions
  - `maxlag=5` on requests
  - retry with backoff on `maxlag` / `ratelimited`
  - in-memory cache (TTL 10 minutes) to reduce repeated calls
- Additional API use:
  - contributor profiles fetched with `list=users` (`editcount|registration|groups`)
  - user-profile requests are batched (50 users per request) and cached in-memory (TTL 10 minutes)

## License

MIT (`LICENSE`)
