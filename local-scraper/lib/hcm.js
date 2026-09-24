export const ID = 'hcm';
export const TITLE = 'HCM (HR gap)';
export const SUMMARY = 'HR presence and headcount ratio';
export const DEFAULTS = { minHeadcount: 20, maxHeadcount: 50, minHrCount: 1, maxHrCount: 1 };

export function run(snapshot, config) {
    const rawFunctions = snapshot.facets?.function ?? [];
    const functions = rawFunctions.map(f => {
        if (typeof f === 'string') {
            return { label: f.replace(/\b(toggle off|toggle on|selected|checkbox)\b/gi, '').trim(), count: 0 };
        }
        const raw = f.label ?? f.name ?? '';
        const cleaned = String(raw).replace(/\b(toggle off|toggle on|selected|checkbox)\b/gi, '').trim();
        return { ...f, label: cleaned, name: cleaned };
    });

    const hrFunc = functions.find(f => {
        const name = f.label ?? f.name ?? '';
        return /human resources|hr/i.test(name);
    });

    const hrCount = hrFunc ? (typeof hrFunc === 'object' ? (hrFunc.count ?? hrFunc.value ?? 0) : 0) : 0;
    const totalMembers = snapshot.totalAssociatedMembers ?? 0;

    const minHeadcount = config?.minHeadcount ?? 20;
    const maxHeadcount = config?.maxHeadcount ?? 50;
    const maxHrCount = config?.maxHrCount ?? 1;

    let verdict = 'REVIEW';
    const hasHeadcount = totalMembers > 0;
    const hasHrFacet = hrFunc !== undefined;

    if (!hasHeadcount && !hasHrFacet) {
        verdict = 'REVIEW';
    } else {
        const headcountPass = (maxHeadcount === null || maxHeadcount === undefined || totalMembers <= maxHeadcount) && totalMembers >= minHeadcount;
        const hrPass = hrCount <= maxHrCount;

        if (headcountPass && hrPass) {
            verdict = 'QUALIFIED';
        } else {
            verdict = 'REJECTED';
        }
    }

    return {
        verdict,
        metrics: { hrCount, totalMembers },
        reasons: [],
        notes: [`HR count: ${hrCount}, Total members: ${totalMembers}`],
    };
}
