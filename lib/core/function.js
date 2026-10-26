const moment = require("moment")

exports.runtime = () => {

    return moment().format(
        "DD/MM/YYYY HH:mm:ss"
    )
}