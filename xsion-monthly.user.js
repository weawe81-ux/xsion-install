// ==UserScript==
// @name         Xsion 月の勤怠を15分単位で入力・変更
// @namespace    xsion-test
// @version      3.2.0
// @match        https://xsion-service.com/nagashimaresort*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    if (window.top !== window.self) return;

    const KEY = 'xsion-monthly-v4';
    const ID = 'xsion-monthly-panel';

    sessionStorage.removeItem('xsion-monthly-v3');

    const clean = s =>
        s.replace(/[\s\u200b：:]/g, '');

    const visible = el =>
        el.getClientRects().length > 0;

    const sleep = ms =>
        new Promise(resolve => setTimeout(resolve, ms));

    const fail = message => {
        throw new Error(message);
    };

    const read = () =>
        JSON.parse(sessionStorage.getItem(KEY) || 'null');

    const write = job =>
        sessionStorage.setItem(KEY, JSON.stringify(job));

    let running = false;
    let cancelled = false;
    let note = '';

    function month() {
        const found = new Set();

        for (const el of document.querySelectorAll(
            'input,select,span,div,td,button'
        )) {
            if (!visible(el)) continue;

            const text = (
                el.tagName === 'INPUT'
                    ? el.value
                    : el.textContent
            ).trim();

            if (/^\d{4}年\s*\d{1,2}月$/.test(text)) {
                found.add(text.replace(/\s/g, ''));
            }
        }

        if (found.size !== 1) {
            fail('表示月を一つに特定できません。月一覧を開いてください。');
        }

        return [...found][0];
    }

    function dateOf(row) {
        return [...row.cells]
            .map(c => c.textContent.trim())
            .find(s =>
                /^\d{1,2}月\d{1,2}日[（(][日月火水木金土][）)]$/.test(s)
            );
    }

    function tableInfo() {
        const candidates = [];

        for (const table of document.querySelectorAll('table')) {
            if (!visible(table)) continue;

            for (const header of table.rows) {
                if (header.closest('table') !== table) continue;

                const labels = [...header.cells]
                    .map(c => clean(c.textContent));

                const names = [
                    '出勤', '退勤', '申請出勤', '申請退勤'
                ];

                if (!names.every(name =>
                    labels.filter(s => s === name).length === 1
                )) continue;

                if ([...header.cells].some(c =>
                    c.colSpan !== 1 || c.rowSpan !== 1
                )) continue;

                if (
                    labels.filter(s => s === '状態').length !== 1
                ) continue;

                candidates.push({
                    table,
                    header,
                    indices: names.map(n => labels.indexOf(n)),
                    statusIndex: labels.indexOf('状態')
                });
            }
        }

        if (candidates.length !== 1) {
            fail('打刻・申請時刻・状態の表を一つに特定できません。');
        }

        return candidates[0];
    }

    function rows(info) {
        return [...info.table.rows].filter(row =>
            row.closest('table') === info.table && dateOf(row)
        );
    }

    function cells(info, row) {
        if (
            row.cells.length !== info.header.cells.length ||
            [...row.cells].some(c =>
                c.colSpan !== 1 || c.rowSpan !== 1
            )
        ) {
            fail('表の列構造が想定と異なります。');
        }

        return info.indices.map(index =>
            row.cells[index].textContent.trim()
        );
    }

    function parse(text) {
        const match = /^(\d{1,2}):([0-5]\d)$/.exec(text);

        return match
            ? Number(match[1]) * 60 + Number(match[2])
            : null;
    }

    function rowState(info, row) {
        const cell = row.cells[info.statusIndex];
        const text = clean(cell.textContent);

        // 「取消」という状態表示と、
        // 取消操作を行うためのボタンを区別する。
        const controls = [
            cell,
            ...cell.querySelectorAll(
                'button,a,input,[role="button"],[onclick]'
            )
        ];

        const cancelAction = controls.some(el =>
            el.matches(
                'button,a,input,[role="button"],[onclick]'
            ) &&
            /取消|取り消/.test(
                (el.value || '') + el.textContent
            )
        );

        const isCancelled =
            /^(取消|取消し|取り消し)(済|済み)?$/.test(text) &&
            !cancelAction;

        return {
            text,
            cancelled: isCancelled,
            cancelAction
        };
    }

    function eligible(text, state) {
        // 出勤・退勤の両方がある日だけ。
        if (
            text.slice(0, 2).some(s => parse(s) === null)
        ) return false;

        // 取消操作のボタンがあるだけでは、
        // 取消済みとは判断しない。
        if (state.cancelAction) return false;

        // 取消済みなら、以前の申請時刻が残っていても対象。
        if (state.cancelled) return true;

        // それ以外は、未入力・未申請で申請欄が空の日だけ。
        return (
            /^(未申請|未入力)?$/.test(state.text) &&
            text.slice(2).every(s =>
                /^(?:[-－—–]{1,2})?$/.test(s)
            )
        );
    }

    function rounded(minutes, up) {
        return (
            up
                ? Math.ceil(minutes / 15)
                : Math.floor(minutes / 15)
        ) * 15;
    }

    function format(minutes) {
        const hour = String(
            Math.floor(minutes / 60)
        ).padStart(2, '0');

        const minute = String(
            minutes % 60
        ).padStart(2, '0');

        return `${hour}:${minute}`;
    }

    function field(label) {
        const pairs = [];

        for (const node of document.querySelectorAll(
            'label,td,th,div,span,p'
        )) {
            if (
                !visible(node) ||
                clean(node.textContent) !== label
            ) continue;

            let el = node;

            for (
                let depth = 0;
                el && depth < 5;
                depth++, el = el.parentElement
            ) {
                const selects = [
                    ...el.querySelectorAll('select')
                ].filter(visible);

                if (selects.length === 2) {
                    if (!pairs.some(pair =>
                        pair[0] === selects[0]
                    )) {
                        pairs.push(selects);
                    }
                    break;
                }

                if (selects.length > 2) break;
            }
        }

        return pairs.length === 1 ? pairs[0] : null;
    }

    function editor() {
        const arrival = field('申請出勤');
        const departure = field('申請退勤');

        if (
            !arrival ||
            !departure ||
            new Set([...arrival, ...departure]).size !== 4
        ) return null;

        return [...arrival, ...departure];
    }

    function editorDate(selects) {
        let row = selects[0].closest('tr');

        while (row) {
            const dates = [
                row,
                row.previousElementSibling
            ]
                .filter(r => r?.tagName === 'TR')
                .map(dateOf)
                .filter(Boolean);

            if (dates.length === 1) return dates[0];

            if (dates.length > 1) {
                fail('編集中の日付が曖昧です。');
            }

            row = row.parentElement?.closest('tr');
        }

        fail('編集欄の日付を確認できません。');
    }

    function editButton(row) {
        const date = dateOf(row);

        const dateCells = [...row.cells].filter(cell =>
            cell.textContent.trim() === date
        );

        if (dateCells.length !== 1) {
            fail('日付のセルを特定できません。');
        }

        const cell = dateCells[0].nextElementSibling;

        if (
            !cell ||
            !/^(TD|TH)$/.test(cell.tagName) ||
            cell.colSpan !== 1
        ) {
            fail(`${date}の鉛筆欄を特定できません。`);
        }

        const nodes = [
            cell,
            ...cell.querySelectorAll('*')
        ].filter(el =>
            visible(el) &&
            !el.closest(':disabled,[aria-disabled="true"]') &&
            !/承認|取消|取り消|削除|申請/.test(
                el.textContent + ' ' + (el.value || '')
            )
        );

        const marked = nodes.filter(el =>
            /編集|修正|edit|pencil|鉛筆/i.test([
                el.getAttribute('title'),
                el.getAttribute('aria-label'),
                el.getAttribute('class'),
                el.getAttribute('alt'),
                el.getAttribute('src')
            ].join(' '))
        );

        const actionable = nodes.filter(el =>
            el.matches(
                'button,a[href],input[type="button"],' +
                'input[type="image"],[role="button"],[onclick]'
            )
        );

        const images = nodes.filter(el =>
            el.matches('img,svg')
        );

        const candidates = marked.length
            ? marked
            : actionable.length
                ? actionable
                : images;

        const targets = candidates.filter(el =>
            !candidates.some(other =>
                other !== el && el.contains(other)
            )
        );

        if (targets.length !== 1) {
            fail(
                `${date}の鉛筆欄：候補${targets.length}個のため停止しました。`
            );
        }

        return targets[0];
    }

    function changeButton() {
        const found = [
            ...document.querySelectorAll(
                'button,a,input[type="submit"],' +
                'input[type="button"],[role="button"]'
            )
        ].filter(el => {
            const text = el.tagName === 'INPUT'
                ? el.value
                : el.textContent;

            return visible(el) &&
                clean(text) === 'タイムカードを変更する';
        });

        if (
            found.length !== 1 ||
            found[0].matches(':disabled,[aria-disabled="true"]')
        ) {
            fail(
                'タイムカード変更ボタンを一つに特定できないか、押せない状態です。'
            );
        }

        return found[0];
    }

    function check(job) {
        if (cancelled || !read()) {
            fail('停止しました。');
        }

        if (
            location.pathname !== job.path ||
            month() !== job.month
        ) {
            fail('ページまたは表示月が変わったため停止しました。');
        }
    }

    async function waitFor(job, get) {
        const end = Date.now() + 20000;

        while (Date.now() < end) {
            check(job);

            const result = get();

            if (result) return result;

            await sleep(300);
        }

        fail(
            '画面の変化を確認できず停止しました。追加確認やエラーが出ていないか確認してください。'
        );
    }

    function targetRow(job, item) {
        const info = tableInfo();

        const matches = rows(info).filter(row =>
            dateOf(row) === item.date
        );

        if (matches.length !== 1) {
            fail(`${item.date}の行を一つに特定できません。`);
        }

        return {
            info,
            row: matches[0]
        };
    }

    async function run() {
        if (running) return;

        running = true;

        try {
            let job = read();

            while (job && job.index < job.items.length) {
                check(job);

                const item = job.items[job.index];

                note =
                    `${job.month} ` +
                    `${job.index + 1}/${job.items.length}：` +
                    item.date;

                draw();

                if (job.phase === 'saving') {
                    await waitFor(job, () => {
                        if (editor()) return false;

                        const { info, row } =
                            targetRow(job, item);

                        const text = cells(info, row);
                        const state = rowState(info, row);

                        return (
                            !state.cancelled &&
                            parse(text[2]) === item.out[0] &&
                            parse(text[3]) === item.out[1]
                        );
                    });

                    job.index++;
                    job.phase = 'next';
                    write(job);

                    continue;
                }

                if (job.phase === 'next') {
                    if (editor()) {
                        fail(
                            '編集欄が開いています。一度閉じてから開始してください。'
                        );
                    }

                    const { info, row } =
                        targetRow(job, item);

                    const text = cells(info, row);
                    const state = rowState(info, row);

                    if (
                        !eligible(text, state) ||
                        state.text !== item.status ||
                        text[2] !== item.requested[0] ||
                        text[3] !== item.requested[1] ||
                        parse(text[0]) !== item.actual[0] ||
                        parse(text[1]) !== item.actual[1]
                    ) {
                        fail(
                            `${item.date}の打刻または申請内容が開始時から変わりました。`
                        );
                    }

                    const button = editButton(row);

                    job.phase = 'editing';
                    write(job);

                    if (typeof button.click === 'function') {
                        button.click();
                    } else {
                        button.dispatchEvent(
                            new MouseEvent('click', {
                                bubbles: true,
                                cancelable: true,
                                view: window
                            })
                        );
                    }
                }

                const selects = await waitFor(job, editor);

                if (
                    editorDate(selects) !== item.date ||
                    selects.some(select => select.disabled)
                ) {
                    fail(
                        '対象日と編集欄が一致しないか、編集できません。'
                    );
                }

                const numbers = item.out.flatMap(minutes => [
                    Math.floor(minutes / 60),
                    minutes % 60
                ]);

                const values = selects.map((select, index) => {
                    const options = [
                        ...select.options
                    ].filter(option =>
                        !option.disabled &&
                        /^\d{1,2}(?:時|分)?$/.test(
                            option.textContent.trim()
                        ) &&
                        Number(
                            option.textContent
                                .trim()
                                .replace(/[時分]/g, '')
                        ) === numbers[index]
                    );

                    if (options.length !== 1) {
                        fail(
                            `${numbers[index]}の選択肢を一つに特定できません。`
                        );
                    }

                    return options[0].value;
                });

                changeButton();

                selects.forEach((select, index) => {
                    if (!select.isConnected) {
                        fail('入力欄が更新されました。');
                    }

                    select.value = values[index];

                    select.dispatchEvent(
                        new Event('input', {
                            bubbles: true
                        })
                    );

                    select.dispatchEvent(
                        new Event('change', {
                            bubbles: true
                        })
                    );
                });

                await sleep(300);

                check(job);

                if (
                    editorDate(selects) !== item.date ||
                    selects.some((select, index) =>
                        !select.isConnected ||
                        select.value !== values[index]
                    )
                ) {
                    fail(
                        '入力結果を確認できません。変更ボタンは押していません。'
                    );
                }

                const button = changeButton();

                job.phase = 'saving';
                write(job);

                button.click();

                await sleep(500);

                job = read();
            }

            if (job) {
                sessionStorage.removeItem(KEY);

                note =
                    `${job.items.length}日分の変更結果を確認しました。` +
                    '承認・取り消しは押していません。';

                alert(note);
            }

        } catch (error) {
            sessionStorage.removeItem(KEY);

            note =
                error.message +
                ' 変更済みの日はそのままです。';

            if (!cancelled) alert(note);

        } finally {
            running = false;
            draw();
        }
    }

    function start() {
        if (running || read()) return;

        try {
            if (editor()) {
                fail(
                    '開いている編集欄を閉じ、月一覧に戻ってから開始してください。'
                );
            }

            const currentMonth = month();
            const info = tableInfo();
            const items = [];

            for (const row of rows(info)) {
                const text = cells(info, row);
                const actual = text.slice(0, 2).map(parse);
                const state = rowState(info, row);

                if (!eligible(text, state)) continue;

                const date = dateOf(row);

                if (items.some(item => item.date === date)) {
                    fail('同じ日付の行が重複しています。');
                }

                editButton(row);

                items.push({
                    date,
                    actual,
                    requested: text.slice(2),
                    status: state.text,
                    cancelled: state.cancelled,
                    out: [
                        rounded(actual[0], true),
                        rounded(actual[1], false)
                    ]
                });
            }

            if (!items.length) {
                fail(
                    '対象はありません。両打刻がある未入力日・取消済みの日が対象です。申請中・承認済みの日や、取消操作のボタンしか確認できない日は処理しません。'
                );
            }

            const preview = items.map(item => {
                const label = item.cancelled
                    ? '（取消後の再入力）'
                    : '';

                return (
                    `${item.date}${label} ` +
                    `${format(item.out[0])}～` +
                    `${format(item.out[1])}`
                );
            }).join('\n');

            if (!confirm(
                `${currentMonth}：${items.length}日分\n\n` +
                preview +
                '\n\n鉛筆→入力→タイムカード変更まで' +
                '順に自動実行します。\n' +
                '承認・取り消しは押しません。\n' +
                '開始しますか？'
            )) return;

            cancelled = false;

            write({
                month: currentMonth,
                path: location.pathname,
                items,
                index: 0,
                phase: 'next'
            });

            run();

        } catch (error) {
            alert(error.message);
        }
    }

    function draw() {
        let panel = document.getElementById(ID);

        if (!panel) {
            panel = document.createElement('div');
            panel.id = ID;

            Object.assign(panel.style, {
                position: 'fixed',
                right: '8px',
                bottom: '75px',
                zIndex: '999999',
                maxWidth: '290px',
                padding: '10px',
                background: '#fff',
                color: '#075d66',
                border: '2px solid #087f8c',
                borderRadius: '10px',
                fontSize: '14px'
            });

            const status = document.createElement('div');
            status.dataset.status = 'true';
            panel.appendChild(status);

            const stop = () => {
                cancelled = true;
                sessionStorage.removeItem(KEY);

                note =
                    '停止しました。' +
                    '送信済みの変更は取り消しません。';

                draw();
            };

            for (const [label, action] of [
                ['未入力・取消分を一括変更', start],
                ['停止', stop]
            ]) {
                const button =
                    document.createElement('button');

                button.type = 'button';
                button.textContent = label;

                button.style.cssText =
                    'padding:10px;' +
                    'margin:4px;' +
                    'font-size:14px';

                button.addEventListener('click', action);
                panel.appendChild(button);
            }

            document.body.appendChild(panel);
        }

        const status = panel.querySelector('[data-status]');

        if (status.textContent !== note) {
            status.textContent = note;
        }
    }

    draw();

    if (read()) run();
})();
