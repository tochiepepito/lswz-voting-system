'use client';

import { useActionState, useState } from 'react';
import { createEventAction, updateEventAction } from '@/server/actions/event.actions';
import { slugify } from '@/lib/slug';
import { toDateTimeLocalInput } from '@/lib/format';
import { RESULTS_VISIBILITY_LABELS, VOTING_TYPE_LABELS } from '@/types/domain';
import type { ResultsVisibility, VotingType } from '@/types/domain';
import { Alert, Card, CsrfField, Field, cx, inputClass, selectClass } from '../ui';
import { SubmitButton } from '../submit-button';

/**
 * Create / edit an event.
 *
 * TWO THINGS WORTH KNOWING
 *
 * 1. Date handling. `<input type="datetime-local">` yields a wall-clock string
 *    with no timezone ("2026-09-15T20:00"). Posting that raw would make the
 *    server interpret the organiser's 8pm as 8pm UTC. The visible input is
 *    therefore paired with a hidden field carrying a full ISO timestamp
 *    converted in the browser, where the operator's timezone is actually known.
 *
 * 2. Options travel as JSON in one hidden field rather than as indexed form
 *    inputs, because the repeated-key encoding cannot express a deletion in the
 *    middle of the list without renumbering everything.
 */

export type OptionDraft = {
  name: string;
  description: string;
  imageUrl: string;
};

export type EventFormDefaults = {
  id?: string;
  title: string;
  slug: string;
  description: string;
  instructions: string;
  votingType: VotingType;
  minSelections: number;
  maxSelections: number;
  startsAt: Date | null;
  endsAt: Date | null;
  resultsVisibility: ResultsVisibility;
  maxVotesPerSession: number;
  ipSoftLimit: number;
  requireCaptcha: boolean;
};

const EMPTY_OPTION: OptionDraft = { name: '', description: '', imageUrl: '' };

/** Convert a `datetime-local` value into an absolute ISO timestamp. */
function toIso(localValue: string): string {
  if (!localValue) return '';

  const date = new Date(localValue);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export function EventForm({
  mode,
  csrfToken,
  defaults,
  ballotLocked = false,
}: {
  mode: 'create' | 'edit';
  csrfToken: string | null;
  defaults: EventFormDefaults;
  /** True once votes exist: the ballot rules become immutable server-side. */
  ballotLocked?: boolean;
}) {
  const action = mode === 'create' ? createEventAction : updateEventAction;
  const [state, formAction] = useActionState(action, null);

  const [votingType, setVotingType] = useState<VotingType>(defaults.votingType);
  const [title, setTitle] = useState(defaults.title);
  const [slug, setSlug] = useState(defaults.slug);
  const [slugEdited, setSlugEdited] = useState(defaults.slug !== '');
  const [startsAt, setStartsAt] = useState(toDateTimeLocalInput(defaults.startsAt));
  const [endsAt, setEndsAt] = useState(toDateTimeLocalInput(defaults.endsAt));
  const [options, setOptions] = useState<OptionDraft[]>([{ ...EMPTY_OPTION }, { ...EMPTY_OPTION }]);

  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const banner = state && !state.ok ? state.message : null;
  const success = state && state.ok ? state.data.message : null;

  const isMulti = votingType === 'MULTIPLE_CHOICE';
  const needsOptions = mode === 'create' && votingType !== 'YES_NO';

  function updateOption(index: number, patch: Partial<OptionDraft>) {
    setOptions((previous) =>
      previous.map((option, position) => (position === index ? { ...option, ...patch } : option)),
    );
  }

  return (
    <form action={formAction} className="space-y-6">
      <CsrfField token={csrfToken} />
      {defaults.id ? <input type="hidden" name="id" value={defaults.id} /> : null}

      {/* Browser-local wall clock converted to an absolute instant. */}
      <input type="hidden" name="startsAt" value={toIso(startsAt)} />
      <input type="hidden" name="endsAt" value={toIso(endsAt)} />

      {needsOptions ? (
        <input
          type="hidden"
          name="optionsJson"
          value={JSON.stringify(
            options
              .filter((option) => option.name.trim() !== '')
              .map((option, index) => ({
                name: option.name.trim(),
                description: option.description.trim() || null,
                imageUrl: option.imageUrl.trim() || null,
                displayOrder: index,
                isActive: true,
              })),
          )}
        />
      ) : null}

      {banner ? <Alert tone="danger">{banner}</Alert> : null}
      {success ? <Alert tone="ok">{success}</Alert> : null}

      {/* ---------------- Basics ---------------- */}
      <Card className="space-y-5 p-5">
        <h2 className="font-semibold">Event details</h2>

        <Field label="Title" htmlFor="title" required errors={errors?.['title']}>
          <input
            id="title"
            name="title"
            required
            maxLength={140}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              // Keep the slug in step until the operator edits it by hand.
              if (!slugEdited) setSlug(slugify(event.target.value));
            }}
            className={inputClass}
            placeholder="2026 Guild Officer Election"
          />
        </Field>

        <Field
          label="URL slug"
          htmlFor="slug"
          hint={`Voters will see /events/${slug || 'your-event'}`}
          errors={errors?.['slug']}
        >
          <input
            id="slug"
            name="slug"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
              setSlugEdited(true);
            }}
            className={cx(inputClass, 'font-mono text-sm')}
            placeholder="2026-guild-officer-election"
          />
        </Field>

        <Field label="Description" htmlFor="description" required errors={errors?.['description']}>
          <textarea
            id="description"
            name="description"
            required
            rows={3}
            maxLength={4000}
            defaultValue={defaults.description}
            className={inputClass}
            placeholder="Choose the next Guild President."
          />
        </Field>

        <Field
          label="Instructions"
          htmlFor="instructions"
          hint="Shown on the ballot. Optional."
          errors={errors?.['instructions']}
        >
          <textarea
            id="instructions"
            name="instructions"
            rows={2}
            maxLength={4000}
            defaultValue={defaults.instructions}
            className={inputClass}
            placeholder="Read each candidate's statement before voting."
          />
        </Field>
      </Card>

      {/* ---------------- Ballot ---------------- */}
      <Card className="space-y-5 p-5">
        <div>
          <h2 className="font-semibold">Ballot</h2>
          {ballotLocked ? (
            <p className="mt-1 text-xs text-warn">
              Votes have already been cast, so the voting type, selection limits and opening time
              can no longer be changed.
            </p>
          ) : null}
        </div>

        <Field label="Voting type" htmlFor="votingType" required errors={errors?.['votingType']}>
          <select
            id="votingType"
            name="votingType"
            value={votingType}
            disabled={ballotLocked}
            onChange={(event) => setVotingType(event.target.value as VotingType)}
            className={selectClass}
          >
            {Object.entries(VOTING_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        {/* A locked select posts nothing, so the value is preserved explicitly. */}
        {ballotLocked ? <input type="hidden" name="votingType" value={votingType} /> : null}

        {isMulti ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Minimum selections"
              htmlFor="minSelections"
              errors={errors?.['minSelections']}
            >
              <input
                id="minSelections"
                name="minSelections"
                type="number"
                min={1}
                max={100}
                defaultValue={defaults.minSelections}
                disabled={ballotLocked}
                className={inputClass}
              />
            </Field>

            <Field
              label="Maximum selections"
              htmlFor="maxSelections"
              errors={errors?.['maxSelections']}
            >
              <input
                id="maxSelections"
                name="maxSelections"
                type="number"
                min={1}
                max={100}
                defaultValue={Math.max(defaults.maxSelections, 2)}
                disabled={ballotLocked}
                className={inputClass}
              />
            </Field>
          </div>
        ) : (
          <>
            <input type="hidden" name="minSelections" value={1} />
            <input type="hidden" name="maxSelections" value={1} />
          </>
        )}

        {votingType === 'YES_NO' ? (
          <Alert tone="info">
            Yes and No options are created automatically for this voting type.
          </Alert>
        ) : null}
      </Card>

      {/* ---------------- Options (create only) ---------------- */}
      {needsOptions ? (
        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Candidates &amp; options</h2>
            <button
              type="button"
              onClick={() => setOptions((previous) => [...previous, { ...EMPTY_OPTION }])}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
            >
              + Add option
            </button>
          </div>

          {errors?.['options'] ? (
            <p className="text-xs font-medium text-danger" role="alert">
              {errors['options'].join(' ')}
            </p>
          ) : null}

          <ol className="space-y-3">
            {options.map((option, index) => (
              <li key={index} className="rounded-card border border-line p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-faint">
                    Option {index + 1}
                  </span>
                  {options.length > 2 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setOptions((previous) => previous.filter((_, position) => position !== index))
                      }
                      className="text-xs font-medium text-danger hover:underline"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>

                <div className="space-y-3">
                  <input
                    aria-label={`Option ${index + 1} name`}
                    value={option.name}
                    onChange={(event) => updateOption(index, { name: event.target.value })}
                    className={inputClass}
                    placeholder="Candidate or option name"
                    maxLength={120}
                  />
                  <input
                    aria-label={`Option ${index + 1} description`}
                    value={option.description}
                    onChange={(event) => updateOption(index, { description: event.target.value })}
                    className={inputClass}
                    placeholder="Short description (optional)"
                    maxLength={1000}
                  />
                  <input
                    aria-label={`Option ${index + 1} image URL`}
                    value={option.imageUrl}
                    onChange={(event) => updateOption(index, { imageUrl: event.target.value })}
                    className={cx(inputClass, 'font-mono text-xs')}
                    placeholder="https://... avatar image (optional)"
                    maxLength={2048}
                  />
                </div>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {/* ---------------- Schedule ---------------- */}
      <Card className="space-y-5 p-5">
        <div>
          <h2 className="font-semibold">Schedule</h2>
          <p className="mt-1 text-xs text-muted">
            Times are entered in your own timezone and stored as absolute instants.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Voting opens"
            htmlFor="startsAtLocal"
            hint="Leave blank to open as soon as you publish."
            errors={errors?.['startsAt']}
          >
            <input
              id="startsAtLocal"
              type="datetime-local"
              value={startsAt}
              disabled={ballotLocked}
              onChange={(event) => setStartsAt(event.target.value)}
              className={inputClass}
            />
          </Field>

          <Field
            label="Voting closes"
            htmlFor="endsAtLocal"
            hint="Leave blank to close it by hand."
            errors={errors?.['endsAt']}
          >
            <input
              id="endsAtLocal"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <Field
          label="Who can see results"
          htmlFor="resultsVisibility"
          errors={errors?.['resultsVisibility']}
        >
          <select
            id="resultsVisibility"
            name="resultsVisibility"
            defaultValue={defaults.resultsVisibility}
            className={selectClass}
          >
            {Object.entries(RESULTS_VISIBILITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      {/* ---------------- Anti-abuse ---------------- */}
      <Card className="space-y-5 p-5">
        <div>
          <h2 className="font-semibold">Anti-abuse</h2>
          <p className="mt-1 text-xs text-muted">
            These thresholds are enforced on the server and are never shown to voters.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Votes allowed per browser"
            htmlFor="maxVotesPerSession"
            hint="Keep at 1 unless players genuinely share a device."
            errors={errors?.['maxVotesPerSession']}
          >
            <input
              id="maxVotesPerSession"
              name="maxVotesPerSession"
              type="number"
              min={1}
              max={50}
              defaultValue={defaults.maxVotesPerSession}
              className={inputClass}
            />
          </Field>

          <Field
            label="Flag after this many votes per network"
            htmlFor="ipSoftLimit"
            hint="Flags for review only, never blocks. 0 disables it."
            errors={errors?.['ipSoftLimit']}
          >
            <input
              id="ipSoftLimit"
              name="ipSoftLimit"
              type="number"
              min={0}
              max={10000}
              defaultValue={defaults.ipSoftLimit}
              className={inputClass}
            />
          </Field>
        </div>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="requireCaptcha"
            defaultChecked={defaults.requireCaptcha}
            className="mt-0.5 h-5 w-5 rounded accent-[rgb(var(--c-accent))]"
          />
          <span className="text-sm">
            <span className="font-medium">Require a CAPTCHA to vote</span>
            <span className="block text-xs text-muted">
              Only takes effect when a CAPTCHA provider is configured for this deployment.
            </span>
          </span>
        </label>
      </Card>

      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingLabel="Saving...">
          {mode === 'create' ? 'Create event' : 'Save changes'}
        </SubmitButton>
      </div>
    </form>
  );
}
