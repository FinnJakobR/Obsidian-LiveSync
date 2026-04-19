enum CardState {
	NEW = 0,
	LEARNING = 1,
	RELEANING = 2,
	REVIEW = 3,
}

export enum Grades {
	MANUAL = 0,
	AGAIN = 1,
	HARD = 2,
	GOOD = 3,
	EASY = 4,
}

export function numToGrade(i: number): Grades {
	switch (i) {
		case 0:
			return Grades.MANUAL;

		case 1:
			return Grades.AGAIN;

		case 2:
			return Grades.EASY;

		case 3:
			return Grades.GOOD;

		case 4:
			return Grades.HARD;

		default:
			throw Error("Unreachable");
	}
}

export type int = number & { __int__: undefined };

const WEIGHTS = [
	0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722,
	0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
	0.0912, 0.0658, 0.1542,
];

interface Log {
	card: Card;
	rating: Grades;
	state: CardState;
	due: Date;
	stability: number;
	difficulty: number;
	elapsed_days: number;
	last_elapsed_days: number;
	scheduled_days: number;
	learning_steps: number;
	review: Date;
}

interface Memory {
	difficulty: number;
	stability: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export class Card {
	public id: string = crypto.randomUUID();
	public difficulty: number = 0;
	public due: Date = new Date();
	public elapsed_days: number = 0;
	public mistakes: number = 0;
	public last_review?: Date;
	public learning_steps: number = 0;
	public reps: number = 0;
	public scheudled_days: number = 0;
	public stability: number = 0;
	public state: CardState = CardState.NEW;

	constructor() {}
}

export default class FreeSpacedRepetitionScheudler {
	private enable_fuzz: boolean;
	private desired_retention: number;
	private maximum_intervall: number;
	private enable_short_term: boolean;
	private nextMap: Map<Grades, Log> = new Map();
	private current: Card | null = null;
	private learning_steps_in_min: number[] = [];
	private relearning_steps_in_min: number[] = [];

	constructor(
		enable_fuzz: boolean,
		desired_retention: number,
		maximum_intervall: number,
		enable_short_term: boolean,
		learning_steps_in_min: number[],
		relearning_steps_in_min: number[],
	) {
		this.enable_fuzz = enable_fuzz;
		this.desired_retention = desired_retention || 0.9;
		this.maximum_intervall = maximum_intervall;
		this.enable_short_term = enable_short_term;
		this.learning_steps_in_min = learning_steps_in_min;
		this.relearning_steps_in_min = relearning_steps_in_min;
	}

	private newState(grade: Grades) {
		const exists = this.nextMap.get(grade);

		if (exists) return exists;
		//this.current!.scheudled_days = 0;

		// const first_intervall = 0;
		// const next_again = this.next_ds(first_intervall, Grades.AGAIN);
		// const next_hard = this.next_ds(first_intervall, Grades.HARD);
		// const next_good = this.next_ds(first_intervall, Grades.GOOD);
		// const next_easy = this.next_ds(first_intervall, Grades.EASY);

		// // if (
		// //   this.current!.state !== CardState.LEARNING &&
		// //   this.current!.state !== CardState.RELEANING
		// // ) {

		// this.applyLearningSteps(next_again, grade, CardState.LEARNING);
		// this.applyLearningSteps(next_hard, grade, CardState.LEARNING);
		// this.applyLearningSteps(next_good, grade, CardState.LEARNING);
		// this.applyLearningSteps(next_easy, grade, CardState.LEARNING);

		const next = this.next_ds(this.current!.elapsed_days, grade);
		this.applyLearningSteps(next, grade, CardState.LEARNING);

		// } else {
		//   console.log("NEXT");
		//   this.next_intervall(
		//     next_again,
		//     next_hard,
		//     next_good,
		//     next_easy,
		//     first_intervall,
		//   );
		// }

		// if (next_again.state !== CardState.LEARNING) {
		//   next_again.state = CardState.REVIEW;
		// }

		//this.update_next(next_again, next_hard, next_good, next_easy);

		//console.log(next.state);

		const item = this.buildLog(grade, next);
		this.nextMap.set(grade, item);

		return item;
	}

	update_next(
		next_again: Card,
		next_hard: Card,
		next_good: Card,
		next_easy: Card,
	) {
		this.nextMap.set(Grades.AGAIN, this.buildLog(Grades.AGAIN, next_again));
		this.nextMap.set(Grades.HARD, this.buildLog(Grades.HARD, next_hard));
		this.nextMap.set(Grades.GOOD, this.buildLog(Grades.GOOD, next_good));
		this.nextMap.set(Grades.EASY, this.buildLog(Grades.EASY, next_easy));
	}

	getLearningSteps(state: CardState): number[] {
		return state === CardState.RELEANING || state == CardState.REVIEW
			? this.relearning_steps_in_min
			: this.learning_steps_in_min;
	}

	getAgainIntervall(state: CardState) {
		return this.getLearningSteps(state)[0];
	}

	getHardIntervall(state: CardState) {
		const steps = this.getLearningSteps(state);
		const firstStep = steps[0];
		if (steps.length == 1) return Math.round(firstStep * 1.5);
		const nextStep = steps[1];

		return Math.round((firstStep + nextStep) / 2);
	}

	getStep(index: number, state: CardState) {
		const steps = this.getLearningSteps(state);
		return steps[index];
	}

	getGoodMinutes(step: number) {
		return step;
	}

	applyLearningStrategy(state: CardState, cur_step: number) {
		const step_info = this.getStep(Math.max(0, cur_step), state);

		if (state == CardState.REVIEW) {
			return { 1: { minutes: step_info, next: 0 } };
		} else {
			let res: Record<number, { minutes: number; next: number }> = {
				1: { minutes: this.getAgainIntervall(state), next: 0 },
				2: { minutes: this.getHardIntervall(state), next: cur_step },
			};

			const next_info = this.getStep(cur_step + 1, state);

			if (next_info) {
				const nextMin = this.getGoodMinutes(next_info);

				if (nextMin) {
					res[3] = {
						minutes: Math.round(nextMin),
						next: cur_step + 1,
					};
				}
			}
			return res;
		}
	}

	getLearningInfo(card: Card, grade: Grades) {
		card.learning_steps = card.learning_steps || 0;

		const strategy = this.applyLearningStrategy(
			card.state,
			card.learning_steps,
		);

		const min = Math.max(0, strategy[grade]?.minutes ?? 0);
		const next_steps = Math.max(0, strategy[grade]?.next ?? 0);

		return {
			min,
			next_steps,
		};
	}

	applyLearningSteps(nextCard: Card, grade: Grades, to_state: CardState) {
		const { min, next_steps } = this.getLearningInfo(nextCard, grade);

		if (min > 0 && min < 1440) {
			nextCard.learning_steps = next_steps;
			nextCard.scheudled_days = 0;
			nextCard.state = to_state;

			nextCard.due = this.getTime(
				this.current!.last_review!,
				Math.round(min) as int,
				false,
			);
		} else {
			nextCard.state = CardState.REVIEW;
			if (min >= 1440) {
				nextCard.learning_steps = next_steps;
				nextCard.due = this.getTime(
					this.current!.last_review!,
					Math.round(min) as int,
					false,
				);

				nextCard.scheudled_days = Math.floor(min / 1440);
			} else {
				nextCard.learning_steps = 0;
				const interval = this.calculateIntervall(
					nextCard.stability,
					this.current!.elapsed_days,
				);

				nextCard.scheudled_days = interval;
				nextCard.due = this.getTime(
					this.current!.last_review!,
					interval as int,
					true,
				);
			}
		}
	}

	buildLog(rating: Grades, card: Card): Log {
		const { last_review, due, elapsed_days } = this.current!;

		return {
			rating: rating,
			card: card,
			state: card.state,
			due: last_review || due,
			stability: card.stability,
			difficulty: card.difficulty,
			elapsed_days: elapsed_days,
			last_elapsed_days: elapsed_days,
			scheduled_days: card.scheudled_days,
			learning_steps: card.learning_steps,
			review: card.last_review!,
		};
	}

	next_intervall(
		next_again: Card,
		next_hard: Card,
		next_good: Card,
		next_easy: Card,
		intervall: number,
	) {
		let again_intervall = this.calculateIntervall(
			next_again.stability,
			intervall,
		);

		let hard_intervall = this.calculateIntervall(
			next_hard.stability,
			intervall,
		);

		let good_intervall = this.calculateIntervall(
			next_good.stability,
			intervall,
		);

		let easy_intervall = this.calculateIntervall(
			next_easy.stability,
			intervall,
		);

		again_intervall = Math.min(again_intervall, hard_intervall) as int;
		hard_intervall = Math.max(hard_intervall, again_intervall + 1) as int;
		good_intervall = Math.max(good_intervall, hard_intervall + 1) as int;
		easy_intervall = Math.max(easy_intervall, good_intervall + 1) as int;

		next_again.scheudled_days = again_intervall;
		next_again.due = this.getTime(
			this.current!.last_review!,
			again_intervall,
			true,
		);

		next_hard.scheudled_days = hard_intervall;
		next_hard.due = this.getTime(
			this.current!.last_review!,
			hard_intervall,
			true,
		);

		next_good.scheudled_days = good_intervall;
		next_good.due = this.getTime(
			this.current!.last_review!,
			good_intervall,
			true,
		);

		next_easy.scheudled_days = easy_intervall;
		next_easy.due = this.getTime(
			this.current!.last_review!,
			easy_intervall,
			true,
		);
	}

	getTime(last_review: Date, t: number, isDay?: boolean) {
		return new Date(
			isDay
				? last_review.getTime() + t * 24 * 60 * 60 * 1000
				: last_review.getTime() + t * 60 * 1000,
		);
	}

	calculateIntervall(stability: number, elapsed_days: number): number {
		const w20 = WEIGHTS[20];
		const factor = Math.pow(0.9, -(1 / w20)) - 1;

		const interval =
			(stability / factor) *
			(Math.pow(this.desired_retention, -(1 / w20)) - 1);

		const clamped = Math.round(
			Math.min(Math.max(1, interval), this.maximum_intervall),
		);

		return this.apply_fuzz(clamped, elapsed_days);
	}

	apply_fuzz(newIntervall: number, elapsed_days: number) {
		return newIntervall;
	}

	next_state(mem: Memory | null, t: number, g: Grades, r?: number) {
		const { difficulty: d, stability: s } = mem ?? {
			difficulty: 0,
			stability: 0,
		};

		if (t < 0) {
			throw new Error("Invalid delta_t");
		}

		if (d === 0 && s == 0) {
			return {
				difficulty: clamp(this.init_difficulty(g), 1, 10),
				stability: this.init_stability(g),
			};
		}

		if (g === Grades.MANUAL) {
			return {
				difficulty: d,
				stability: s,
			};
		}

		r = typeof r === "number" ? r : this.forgetting_curve(t, s);

		let new_stability: number;
		if (t === 0 && this.enable_short_term) {
			new_stability = this.next_short_term_stability(s, g);
		} else if (g == Grades.AGAIN) {
			new_stability = this.next_again_stability(s, r, d);
		} else {
			new_stability = this.next_stability(s, d, r, g);
		}

		const new_diffculty = this.next_difficulty(d, g);
		return { difficulty: new_diffculty, stability: new_stability };
	}

	next_difficulty(difficulty: number, grade: Grades) {
		const delta_difficulty = -WEIGHTS[6] * (grade - 3);
		const linear_damped_difficulty =
			difficulty + delta_difficulty * ((10 - difficulty) / 9);

		const next_difficulty =
			WEIGHTS[7] * this.init_difficulty(4) +
			(1 - WEIGHTS[7]) * linear_damped_difficulty;

		return clamp(next_difficulty, 1, 10);
	}

	next_stability(
		stability: number,
		difficulty: number,
		r: number,
		g: Grades,
	) {
		const hard_penalty = Grades.HARD === g ? WEIGHTS[15] : 1;
		const easy_bound = Grades.EASY === g ? WEIGHTS[16] : 1;

		const x =
			1 +
			Math.exp(WEIGHTS[8]) *
				(11 - difficulty) *
				Math.pow(stability, -WEIGHTS[9]) *
				(Math.exp(WEIGHTS[10] * (1 - r)) - 1) *
				hard_penalty *
				easy_bound;
		return stability * x;
	}

	next_short_term_stability(stability: number, grade: Grades): number {
		const short_term_stability =
			stability *
			Math.exp(WEIGHTS[17] * (grade - 3 + WEIGHTS[18])) *
			Math.pow(stability, -WEIGHTS[19]);

		return short_term_stability;
	}

	next_again_stability(stability: number, r: number, d: number) {
		return Math.min(
			WEIGHTS[11] *
				Math.pow(d, -WEIGHTS[12]) *
				(Math.pow(stability + 1, WEIGHTS[13]) - 1) *
				Math.exp(WEIGHTS[14] * (1 - r)),
			stability,
		);
	}

	forgetting_curve(elapsed_time: number, stability: number): number {
		const x = Math.pow(0.9, -(1 / WEIGHTS[20])) - 1;
		return Math.pow(1 + x * (elapsed_time / stability), -WEIGHTS[20]);
	}

	cloneCard(card: Card): Card {
		const newCard = new Card();
		Object.assign(newCard, card);
		return newCard;
	}

	next_ds(t: number, g: Grades, r?: number) {
		const next_state = this.next_state(
			{
				difficulty: this.current!.difficulty,
				stability: this.current!.stability,
			},
			t,
			g,
			r,
		);

		const card = this.cloneCard(this.current!);
		card.difficulty = next_state.difficulty;
		card.stability = next_state.stability;

		return card;
	}

	init_difficulty(g: Grades) {
		return WEIGHTS[4] - Math.exp((g - 1) * WEIGHTS[5]) + 1;
	}

	init_stability(g: Grades) {
		return Math.max(WEIGHTS[g - 1], 0.1);
	}

	// init_stability(g: Grades) {
	//   switch (g) {
	//     case 0:
	//       return 0.0;
	//     case 1:
	//       return 0.212;
	//     case 2:
	//       return 1.2931;
	//     case 3:
	//       return 2.3065;
	//     case 4:
	//       return 8.2956;
	//   }

	//   return 0;
	// }

	review(grade: Grades): Log {
		const { state } = this.current!;

		let item: Log | undefined;

		switch (state) {
			case CardState.NEW:
				item = this.newState(grade);
				break;

			case CardState.LEARNING:
			case CardState.RELEANING:
				item = this.learningState(grade);
				break;

			case CardState.REVIEW:
				item = this.reviewState(grade);

				break;
		}

		return item;
	}

	reviewState(grade: Grades): Log {
		const exist = this.nextMap.get(grade);
		if (exist) {
			return exist;
		}

		const interval = this.current!.elapsed_days;

		const retrievability = this.forgetting_curve(
			interval,
			this.current!.stability,
		);

		const next_again = this.next_ds(interval, Grades.AGAIN, retrievability);
		const next_hard = this.next_ds(interval, Grades.HARD, retrievability);
		const next_good = this.next_ds(interval, Grades.GOOD, retrievability);
		const next_easy = this.next_ds(interval, Grades.EASY, retrievability);

		this.next_intervall(
			next_again,
			next_hard,
			next_good,
			next_easy,
			interval,
		);
		this.n_state(next_hard, next_good, next_easy);
		this.applyLearningSteps(next_again, Grades.AGAIN, CardState.RELEANING);

		next_again.mistakes += 1;

		this.update_next(next_again, next_hard, next_good, next_easy);
		return this.nextMap.get(grade)!;
	}

	private n_state(next_hard: Card, next_good: Card, next_easy: Card) {
		next_hard.state = CardState.REVIEW;
		next_hard.learning_steps = 0;

		next_good.state = CardState.REVIEW;
		next_good.learning_steps = 0;

		next_easy.state = CardState.REVIEW;
		next_easy.learning_steps = 0;
	}

	learningState(grade: Grades): Log {
		const next = this.cloneCard(this.current!);

		this.applyLearningSteps(next, grade, this.current!.state);

		const item = this.buildLog(grade, next);

		this.nextMap.set(grade, item);
		return item;
	}

	next(card: Card, now: Date, grade: Grades) {
		this.nextMap.clear();
		this.current = card;

		if (card.last_review) {
			const elapsed = Math.floor(
				(now.getTime() - card.last_review.getTime()) /
					(1000 * 60 * 60 * 24),
			);

			card.elapsed_days = elapsed;
		} else {
			card.elapsed_days = 0;
		}

		card.last_review = now;
		card.reps += 1;

		return this.review(grade);
	}
}
