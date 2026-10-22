#include "MinaCalc/MinaCalc.h"
#include <algorithm>
#include <cmath>
#include <cstddef>

// Do not expose a C++ class, allocation, exception, or STL type across the ABI.
extern "C" int vosu_minacalc(const NoteInfo* rows, size_t count,
                             unsigned keys, float rate, float goal,
                             bool ssr, float* out) noexcept {
    try {
        if (count <= 1) {
            std::fill(out, out + 8, 0.F);
            return 0;
        }
        Calc calc;
        std::vector<NoteInfo> notes(rows, rows + count);
        calc.keycount = keys;
        calc.ssr = ssr;
        auto result = ssr ? MinaSDCalc(notes, rate, goal, keys, &calc)
                          : calc.CalcMain(notes, rate, 0.93F);
        if (result.size() != 8) return 1;
        for (size_t i = 0; i < 8; ++i) {
            if (!std::isfinite(result[i])) return 2;
            out[i] = result[i];
        }
        return 0;
    } catch (...) {
        return 3;
    }
}

// Export the existing per-hand interval arrays without altering calculator arithmetic.
extern "C" int vosu_minacalc_intervals(const NoteInfo* rows, size_t count,
    unsigned keys, float rate, float* out, size_t capacity, size_t* written) noexcept {
    try {
        *written = 0;
        if (count <= 1) return 0;
        Calc calc;
        calc.keycount = keys;
        std::vector<NoteInfo> notes(rows, rows + count);
        calc.CalcMain(notes, rate, 0.93F);
        if (static_cast<size_t>(calc.numitv) > capacity) return 4;
        for (int i = 0; i < calc.numitv; ++i) {
            for (size_t skill = 0; skill < 8; ++skill) {
                float value = std::max(calc.base_adj_diff[0][skill][i],
                                       calc.base_adj_diff[1][skill][i]);
                if (!std::isfinite(value)) return 2;
                out[static_cast<size_t>(i) * 8 + skill] = value;
            }
        }
        *written = static_cast<size_t>(calc.numitv);
        return 0;
    } catch (...) { return 3; }
}
