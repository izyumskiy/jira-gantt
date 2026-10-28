# How to read the Control Chart

*[Русская версия](HOWTO.md)*

The Control Chart answers one question: **how long an issue spends in progress,
and how predictable that duration is**. Every dot is a completed issue: the
horizontal axis is the moment it reached “Done”, the vertical axis is its cycle
time.

Below: how to set the sample up, what to look at step by step, and which
conclusions the chart actually supports.

---

## What is what on the screen

The header has a target-shaped button. It turns on the interface hints:
numbered markers appear over the real elements, and clicking a number explains
what it is and why it is there. Leave with Esc or the button at the bottom. The
same list for reading.

Separately: every statistics card, and the “Cycle time”, “Lead time” and
“85th / median” column headers, carry their own hint on hover — what the number
means and how to read it. That works at all times, with no need to turn the
markers on.

The elements:

| # | Element | What it is for |
|---|---|---|
| 1 | Board | Board selection and loading the board list from Jira |
| 2 | Refresh data | Fetches only what changed since the last export |
| 3 | Full export | Re-reads the whole board history from scratch |
| 4 | Forecast | When a project of N issues will be done: Monte Carlo over weekly throughput |
| 5 | Period | Filters by completion date, not creation date |
| 6 | Cycle statuses | Time spent in them is the cycle time |
| 7 | Done statuses | Reaching them places the dot along the horizontal axis |
| 8 | Issue types | Only homogeneous work is worth comparing |
| 9 | Assignees | Filter by person; the icon by the heading selects everyone |
| 10 | Rolling average window | The share of the sample behind the green line |
| 11 | Excluded | Why issues missed the chart; two rows are clickable |
| 12 | Summary | Median and percentiles; the mean is the wrong number to read |
| 13 | Chart | A dot is an issue; drag to zoom, double-click to reset |
| 14 | Comparison by assignee | The same metrics per person; a row click highlights them |
| 15 | Issues | The list, with sorting, search and CSV export |
| 16 | Storage | Space used, and data cleanup |

---

## How to use it: five steps

### Step 0. Getting the sample right is 80% of the job

The chart lies exactly as much as the filters are careless.

**Cycle statuses** answer the question “from what moment do we consider the work
started?”. The list on the left is grouped by board columns: ticking a column
name selects all of its statuses at once, but any single status can be ticked on
its own — which matters when one column mixes different outcomes (say `Done` and
`Cancelled`: cancelled issues are worth excluding, otherwise they distort the
metric).

Two workable options, both honest, but answering different questions:

- from “In Progress” to “Done”, waiting excluded — how much time the team actually spends;
- everything from “In Progress” including “Waiting”, “In Test”, “To Release” — how long the **customer waits**. This is usually the one you want.

A separate group, **“Not in board columns”**, shows up when issues passed through
statuses that are not mapped to any column. By default that time counts nowhere —
neither towards the cycle nor anywhere else — which is why the group is flagged
with an exclamation mark. If something like `On Hold` or `Blocked` sits there,
that time is silently missing from your metric; tick those statuses to see the
real picture.

The same status cannot meaningfully live in both the cycle and “Done”: the finish
line is the moment the issue enters the first “done” status, so time spent there
never reaches the cycle and the tick in the cycle list does nothing. Decide where
the finish line is.

The main rule: once chosen, keep it. Comparing measurements taken with different
sets of statuses is meaningless.

**Period** — 3 to 6 months. Less than that leaves too few dots and the rolling
average turns into noise. More than that mixes different eras of the team: a
different line-up, a different process.

**Issue types** — look at one at a time. A bug and a large task have different
distributions; together they produce an average that describes neither.

### Step 1. Forget the mean, look at the 85th percentile

The mean of a skewed distribution is close to useless. Percentiles work:

- **50th (median)** — the “typical” issue;
- **85th** — what you can promise externally: 85 issues out of 100 fit inside it;
- **95th** — what to plan for when you are accounting for risk.

A sentence you can safely say to the business: *“half of the issues take 6 days,
85% take up to 13”*. That is honest and verifiable, unlike “about a week on
average”.

### Step 2. Judge the spread before the speed

Look at the width of the ±1σ band and at the ratio of the 85th percentile to the
median:

| 85th / median | What it means |
|---|---|
| up to 1.5 | predictable process, you can plan against it |
| 1.5–2.5 | the usual situation; plan by the 85th percentile |
| above 2.5 | the process is not under control, do not quote dates |

The **CV** card shows the same thing from another angle: the coefficient of
variation, σ divided by the mean. It is colour-coded by threshold: green up to
0.5 (predictable, the mean is worth planning by), blue up to 1 (ordinary
development, plan by percentiles), yellow above 1 (the tail rules the
distribution and the mean describes no real issue).

A CV above 1 means exactly this: the typical error of a prediction is larger
than the prediction itself. For such a distribution the “mean ± σ” interval runs
into negative numbers, which durations cannot be, so the entire spread lives in
the right tail.

A stable process at 10 days beats one bouncing between 2 and 20. The first lets
you make promises, the second does not.

### Step 3. Check the trend of the rolling average

The line answers exactly one question: **did anything change after you changed
something**. Introduced code review, split the team, imposed a WIP limit — find
that date on the X axis and see whether the line reacted over the following three
or four weeks. If the line is flat, the change did not work. Unpleasant, but
useful.

The “Rolling average window” slider controls sensitivity: 10% smooths everything
into a straight line, 3–4% shows sprint-level swings. Move it both ways — anything
visible at only one window size is probably an artefact.

### Step 4. Go through the tail one issue at a time

Dots above the 85th percentile are the only place where improvements live. Not
“optimise the process” in general, but take the ten slowest issues and read their
history.

Hover a dot and the tooltip shows the breakdown by status (“In Progress: 2d,
Waiting: 18d”); clicking opens the issue in Jira. The table below is sorted by
cycle time, and the “Export CSV” button is there if a spreadsheet suits you
better.

Look not for “it took long to build” but for **where it stood still**. Almost
always it turns out that 80% of the time the issue was not being worked on at all:
it was waiting for review, for an answer from the customer, for a release window,
for a free tester.

### Step 4b. Comparing assignees

The table under the chart computes the same metrics per person, and clicking a
row highlights that person's dots against everyone else's. It answers the
question “does this person differ from the overall flow” — the team stays in
view as the background, so the difference reads more honestly than switching
between separate per-person boards.

Two caveats, without which the comparison is meaningless. First, percentiles on
a sample below 20 issues swing by days on chance alone, so those cells are
greyed out. Second, people can only be compared on a homogeneous sample: filter
to a single issue type, otherwise the difference reflects the mix of work rather
than the person.

And remember what these numbers do not contain: the difficulty of the work, or
who on the team reviews everyone else's code. They answer “where does this
person's time go” well. They do not answer “who works better”.

**Teams.** A person's team, role and status come from the OhMyGant “Team” tab —
the Gantt and the Control Chart share one people table. When teams are set
there, assignees in the left-hand filter are grouped by team (the team checkbox
selects or clears the whole team), and the comparison table gets a
**People / Teams** switch: in “Teams” mode a row is a team, and clicking it
highlights all its people on the chart. Former staff are struck through,
outstaff people are marked.

### Step 5. Look regularly

A single chart is a snapshot. Meaning appears with regular review: once a sprint
or once a month, same filters, always the same question — what changed since last
time, and why.

---

## What the Control Chart reveals

| What you see | What it means | What to do |
|---|---|---|
| Flat line, narrow band | Predictable process | Quote dates by the 85th percentile, leave the process alone |
| Wide band, σ ≈ median | Different kinds of work mixed together, or a lot of waiting | Split by type, check the status breakdown in the tail |
| Line creeping up | WIP is piling up, the queue is growing, the process is degrading | Limit the number of issues in progress |
| Line dropping after a specific date | The change worked | Lock the practice in |
| Dense layer of dots near zero | Empty issues, duplicates, or work happening outside the board | Find out what those issues actually are |
| Vertical columns of dots on particular days | Batch closing at the end of a sprint: the completion date is administrative, not factual | Close issues when they are done, otherwise the metric measures the ritual |
| Isolated dots far above | Stuck work: a blocker, an external dependency, a forgotten issue | Go through them one by one — the cheapest source of improvement |
| A gap with no dots at all | Nothing was completed: holidays, a crunch, one large task swallowing the team | Check whether the work fell apart into invisible pieces |
| Spread grew, mean unchanged | The process lost control before it showed up in the dates | An early warning — react now |

The value of the tool in one sentence: **it moves the conversation about dates
from opinions to data**. “I feel like we have got slower” turns into “the median
went from 4 to 7 days in April”, and that can be discussed properly.

---

## Forecasting a project deadline

The **Forecast** button in the header answers “when will a project of 60 issues
be done”. It works from throughput rather than from issue durations, and here is
why.

**Estimates cannot be added up, for two reasons.** Percentiles do not add: the
project only overruns the sum of the 85th percentiles if every issue is late at
once, which is a fraction of a percent. That sum is close to the 99th percentile
of the project — a date you always beat, and customers notice. And cycles
overlap: while one issue waits for review its assignee works on another, so
adding cycle times counts the queues twice.

**How the plugin computes it.** It takes the history of weekly throughput (how
many issues the board pushes to “Done” per week), draws random weeks with
replacement until the project scope is covered, and repeats ten thousand times.
Percentiles are taken from the resulting durations. Partial weeks at the edges of
the period are dropped; weeks with zero stay, because holidays are part of the
flow too.

**The share of flow is the most expensive correction.** A board's throughput
serves every project at once plus operational work, and your project gets a
slice. If 5 of the 13 weekly issues go to the project, then 60 issues take 11
weeks, not 4.5. That factor of two and a half is the price of the neighbouring
customers. The share can be measured by filtering the board down to the project,
or simply assigned — in which case the result is flagged as an estimate.

**Several teams do not add up.** Every run simulates each team against its own
history, and the project duration is the maximum: the project is done when the
last team finishes. Even if each of three teams holds its own 85th percentile,
all three hold it together only in 0.85³ ≈ 61% of cases. The “who finished last”
line shows how often each team was the straggler — that is your bottleneck.

**What the forecast cannot do.** It assumes the project issues are like the
historical ones and knows nothing about dependencies: a strict sequential chain
takes longer. With fewer than five full weeks of history it refuses to compute;
with fewer than twelve it warns.

---

## What the Control Chart does not show

- **How much was done.** Cycle time says nothing about volume. A team can get twice as fast while delivering half as much. For volume you need throughput and a cumulative flow diagram (CFD).
- **Individual performance.** Using this metric to evaluate people is a reliable way to destroy it: they will start splitting issues and closing them early, the number will improve, the flow will not.
- **Effort.** The clock is calendar time, weekends and holidays included. Seven days on the chart is about five working days — and still not five person-days of work: most of the time the issue is simply sitting there.
- **Issue size.** An hour-long task and a week-long one are two identical dots. That accounts for part of the spread.

A terminological note: what Jira calls a Control Chart is not the Shewhart control
chart from statistical process control. There the limits are drawn at ±3σ and
serve as a criterion for “the process is out of control”. Here the ±1σ band is
simply a visualisation of the spread and provides no formal criterion. Same name,
different mathematics.

---

## What the Control Chart actually computes

- **A dot** is a completed issue. X is the moment it entered the “Done” statuses; if the issue was reopened, the last entry is used. Y is the cycle time.
- **Cycle time** is the sum of the intervals the issue spent in the selected cycle statuses, up to the moment it reached “Done”.
- **The rolling average** is the mean over a window centred on each dot; the window size is set by the slider as a share of the sample.
- **The ±1σ band** is the standard deviation inside that same window.
- **Outliers** (the “Hide outliers” checkbox) are dots above `Q3 + 1.5 × IQR`. While the box is ticked, the percentiles and the maximum are computed on the trimmed sample, so they look more optimistic than reality.

- **Efficiency** is the time logged against the issues divided by their cycle time. It answers what share of the elapsed time went into work and what share into waiting. For most teams it lands between 5% and 15%: if that is your case, the thing to speed up is not development but everything in between. It is computed only over issues that have logged time, so it is exactly as honest as your worklog discipline.

Issues that did not make it onto the chart are listed under “Excluded” with their
reasons. Two of the rows are clickable and open a breakdown by status:

- **“not finished”** — which status the issues are sitting in right now. Shows where unfinished work accumulates.
- **“no time in the selected statuses”** — where the issues spent their time before reaching “Done”. If a working status you have not selected appears in that list, ticking it brings those issues back onto the chart. If only the initial status is there, the issues were closed without ever being worked on.
